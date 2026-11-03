import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CiParams, CiRunnerResult, CloudflareArtifacts } from "@cloudflare/ci"
import type { CiBindings } from "@cloudflare/ci/worker"
import { test as base } from "@tests/database"
import { copySlateProject } from "@usecontextlayer/dev-env/slate"
import { mcpManifestSchema } from "@usecontextlayer/shared/mcp"
import { getAgentByName } from "agents/routing"
import { execa } from "execa"
import { expect } from "vitest"
import { z } from "zod"
import { getAgentInstanceName } from "@/agent-instance"
import { agentRuntimeScheduleSchema } from "@/agents.schema"
import type { PlatformEnv } from "@/context"
import { prepareSlateDatabase } from "@/slate-resource-configuration.server"
import { slateSchema } from "@/slates.schema"
// biome-ignore lint/style/noRestrictedImports: shared Worker fixtures live outside the package
import * as workerFixtures from "../../../vitest.workers.ts"

const test = base.extend(
	"workers",
	({ databases }): workerFixtures.WorkerInputs => [
		{
			...workerFixtures.platformWorkerInput,
			secrets: { CTX_PLATFORM_DATABASE_URL: databases.urls.ctx_platform_test },
		},
		workerFixtures.buildWorkerInput,
		workerFixtures.dispatcherWorkerInput,
	],
)

test.for(["app", "mcp", "public", "empty", "agents"] as const)(
	"the build Workflow publishes %s source through native Cloudflare output",
	{ timeout: 900_000 },
	async (source, { db, harness }) => {
		await using resources = new AsyncDisposableStack()
		const directory = await mkdtemp(join(tmpdir(), `slate-build-${source}-`))
		resources.defer(() => rm(directory, { force: true, recursive: true }))
		const checkout = join(directory, "author")
		await harness.listen()
		const { AGENTS, ARTIFACTS, DATABASES } = await harness
			.getWorker<PlatformEnv["Bindings"]>("contextlayer-platform-test")
			.getEnv()
		const buildWorker = harness.getWorker<
			CiBindings & {
				CTX_DISPATCH_NAMESPACE: string
			}
		>("contextlayer-build-test")
		const buildEnv = await buildWorker.getEnv()
		const { SLATES } = await harness
			.getWorker<{ SLATES: DispatchNamespace }>("contextlayer-dispatcher-test")
			.getEnv()
		const slate = slateSchema.parse({
			id: crypto.randomUUID(),
			owner_organization_id: null,
			owner_user_id: "build-acceptance",
			public_hostname: `${crypto.randomUUID()}.contextlayer.xyz`,
			visibility: "private",
		})
		await db.insertInto("slate").values(slate).execute()
		const repo = await ARTIFACTS.create(slate.id)
		resources.defer(async () => {
			await ARTIFACTS.delete(slate.id)
		})

		const execute = execa({
			cwd: directory,
			env: {
				CLOUDFLARE_ACCOUNT_ID: buildEnv.CLOUDFLARE_ACCOUNT_ID,
				CLOUDFLARE_API_TOKEN: buildEnv.CF_TOKEN,
				WRANGLER_SEND_METRICS: "false",
			},
		})
		const namespace = buildEnv.CTX_DISPATCH_NAMESPACE
		resources.defer(async () => {
			await execute("pnpm", [
				"dlx",
				"cf",
				"workers-for-platforms",
				"dispatch-namespaces",
				"scripts",
				"delete",
				slate.id,
				"--dispatch-namespace",
				namespace,
				"--force",
			])
		})
		await copySlateProject(checkout, { scaffold: source })
		if (source === "app") {
			await writeFile(
				join(checkout, "app/routes.ts"),
				`import { index, route, type RouteConfig } from "@react-router/dev/routes"
export default [index("routes/home.tsx"), route("build-proof", "routes/build-proof.ts")] satisfies RouteConfig
`,
			)
			await writeFile(
				join(checkout, "app/routes/build-proof.ts"),
				`export function loader() { return new Response(${JSON.stringify(slate.id)}) }\n`,
			)
			await writeFile(join(checkout, "public/build-proof.txt"), slate.id)
			await writeFile(
				join(checkout, "public/index.html"),
				`<p>Static index ${slate.id}</p>`,
			)
		} else if (source === "mcp") {
			await writeFile(
				join(checkout, "mcp/tool/index.ts"),
				`import { z } from "zod"
export const tool = {
  inputSchema: z.object({ value: z.number() }),
  name: "tool",
}
export function handler({ value }: z.infer<typeof tool.inputSchema>) {
  return { content: [{ text: String(value), type: "text" as const }] }
}
`,
			)
			await mkdir(join(checkout, "mcp-ui/tool"), { recursive: true })
			await writeFile(
				join(checkout, "mcp-ui/tool/index.html"),
				'<p>Published View</p><script type="module" src="./view.ts"></script>',
			)
			await writeFile(
				join(checkout, "mcp-ui/tool/view.ts"),
				'document.documentElement.dataset.proof = "published-view-script"',
			)
		} else if (source === "public") {
			await writeFile(
				join(checkout, "public/index.html"),
				`<p>Public index ${slate.id}</p>`,
			)
			await writeFile(join(checkout, "public/proof.bin"), new Uint8Array([0, 255, 128]))
			await mkdir(join(checkout, "public/.well-known"))
			await writeFile(join(checkout, "public/.well-known/proof"), slate.id)
		} else if (source === "agents") {
			await mkdir(join(checkout, "agents/agent/schedules"))
			await writeFile(
				join(checkout, "agents/agent/schedules/publish.md"),
				'---\ncron: "0 0 1 1 *"\n---\nAcknowledge the publication.\n',
			)
		}
		const git = async (...args: string[]) =>
			(
				await execa("git", args, {
					cwd: checkout,
					env: {
						GIT_CONFIG_COUNT: "1",
						GIT_CONFIG_KEY_0: "http.extraHeader",
						GIT_CONFIG_VALUE_0: `Authorization: Bearer ${repo.token}`,
					},
				})
			).stdout.trim()
		await git("init", "-b", "main")
		await git("config", "user.name", "Build Acceptance")
		await git("config", "user.email", "build-acceptance@example.com")
		await git("add", ".")
		await git("-c", "commit.gpgsign=false", "commit", "-m", "Author deployment fixture")
		await git("push", repo.remote, "main")

		const id = crypto.randomUUID()
		resources.defer(async () => {
			let cursor: string | undefined
			do {
				const page = await buildEnv.BACKUP_BUCKET.list({
					cursor,
					prefix: `build-artifacts/${id}/`,
				})
				if (page.objects.length > 0) {
					await buildEnv.BACKUP_BUCKET.delete(page.objects.map(({ key }) => key))
				}
				cursor = page.truncated ? page.cursor : undefined
			} while (cursor)
		})
		await buildEnv.CI_WORKFLOW.create({
			id,
			params: {
				branch: "main",
				event: { type: "push" },
				owner: "contextlayer-test",
				provider: "cloudflare-artifacts",
				providerData: { namespace: "contextlayer-test" },
				ref: "refs/heads/main",
				repo: slate.id,
				sha: await git("rev-parse", "HEAD"),
				trigger: "push",
			} satisfies CiParams<CloudflareArtifacts>,
		})
		await using workflow = await buildWorker.introspectWorkflowInstance("CI_WORKFLOW", id)
		await Promise.all([
			workflow.waitForStepResult({ name: "build" }).then((result) => {
				const { snapshot } = result as Pick<CiRunnerResult, "snapshot">
				resources.defer(() =>
					buildEnv.BACKUP_BUCKET.delete([
						`backups/${snapshot.id}/data.sqsh`,
						`backups/${snapshot.id}/meta.json`,
					]),
				)
			}),
			workflow.waitForStatus("complete"),
		])
		expect(await workflow.getOutput()).toEqual({ conclusion: "success" })
		const { stdout } = await execute("pnpm", [
			"dlx",
			"cf",
			"workers-for-platforms",
			"dispatch-namespaces",
			"scripts",
			"bindings",
			"get",
			slate.id,
			"--dispatch-namespace",
			namespace,
		])
		const bindings = z
			.array(z.object({ name: z.string(), type: z.string() }))
			.parse(JSON.parse(stdout))
		expect(bindings).toEqual([])
		const deployed = SLATES.get(slate.id)
		if (source === "app") {
			const database = prepareSlateDatabase(slate, null, "notes", {
				consumers: [{ type: "app" }],
				mode: "owner",
			})
			const notes = DATABASES.getByName(database.instance_name)
			expect((await notes.query("SELECT * FROM notes")).rows).toEqual([])
			expect((await notes.query("SELECT name FROM kysely_migration")).rows).toEqual([
				{ name: "001_create_notes" },
			])
			for (const path of ["/build-proof", "/build-proof.txt"]) {
				const response = await deployed.fetch(`https://${slate.public_hostname}${path}`)
				expect(response.status).toBe(200)
				expect(await response.text()).toBe(slate.id)
			}
			const index = await deployed.fetch(`https://${slate.public_hostname}/`)
			expect(index.status).toBe(200)
			expect(await index.text()).toBe(`<p>Static index ${slate.id}</p>`)
		} else if (source === "mcp") {
			const catalog = await deployed.fetch(`https://${slate.public_hostname}/mcp.json`)
			expect(catalog.status).toBe(200)
			const manifest = mcpManifestSchema.parse(await catalog.json())
			expect(manifest.tools).toMatchObject([
				{ declaration: { connections: {}, databases: {}, secrets: {} }, name: "tool" },
			])
			expect(manifest.resources).toEqual([
				{
					mimeType: "text/html;profile=mcp-app",
					name: "tool",
					path: "/mcp-ui/tool/",
					uri: "ui://tool/index.html",
				},
			])
			const view = await deployed.fetch(`https://${slate.public_hostname}/mcp-ui/tool/`)
			expect(view.status).toBe(200)
			const html = await view.text()
			expect(html).toContain("Published View")
			const script = html.match(/<script[^>]*src="([^"]+)"/)?.[1]
			if (!script) throw new Error("Published View must reference its compiled script")
			const asset = await deployed.fetch(
				new URL(script, `https://${slate.public_hostname}`).href,
			)
			expect(asset.status).toBe(200)
			expect(await asset.text()).toContain("published-view-script")
			const result = await SLATES.get(slate.id, { props: { mcpTool: "tool" } }).fetch(
				`https://${slate.public_hostname}/mcp`,
				{ body: JSON.stringify({ value: 42 }), method: "POST" },
			)
			expect(result.status).toBe(200)
			expect(await result.json()).toEqual({ content: [{ text: "42", type: "text" }] })
		} else if (source === "public") {
			const index = await deployed.fetch(`https://${slate.public_hostname}/`)
			expect(index.status).toBe(200)
			expect(await index.text()).toBe(`<p>Public index ${slate.id}</p>`)
			const binary = await deployed.fetch(`https://${slate.public_hostname}/proof.bin`)
			expect(binary.status).toBe(200)
			expect(new Uint8Array(await binary.arrayBuffer())).toEqual(
				new Uint8Array([0, 255, 128]),
			)
			const hidden = await deployed.fetch(
				`https://${slate.public_hostname}/.well-known/proof`,
			)
			expect(hidden.status).toBe(200)
			expect(await hidden.text()).toBe(slate.id)
		} else if (source === "agents") {
			const agent = await getAgentByName(
				AGENTS,
				getAgentInstanceName(slate.id, "agent", { type: "app" }),
			)
			expect(
				z.array(agentRuntimeScheduleSchema).parse(await agent.listAuthoredSchedules()),
			).toMatchObject([
				{
					callback: "runScheduled",
					cron: "0 0 1 1 *",
					payload: {
						actor: { type: "app" },
						name: "agent",
						prompt: "Acknowledge the publication.\n",
						schedule: "publish",
						slateId: slate.id,
					},
					type: "cron",
				},
			])
			expect(await agent.listJobs()).toEqual([])
		}
		if (source === "mcp" || source === "empty" || source === "agents") {
			expect((await deployed.fetch(`https://${slate.public_hostname}/`)).status).toBe(404)
		}
		for (const path of ["/slate.json", "/app/slate.json"]) {
			expect(
				(await deployed.fetch(`https://${slate.public_hostname}${path}`)).status,
			).toBe(404)
		}
	},
)
