import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { CiParams, CiRunnerResult, CloudflareArtifacts } from "@cloudflare/ci"
import type { CiBindings } from "@cloudflare/ci/worker"
import { test as base } from "@tests/database"
import type { Workers } from "@tests/workers"
import { createSlateProject } from "@usecontextlayer/dev-env/slate"
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

const test = base.extend(
	"workers",
	({ databases }): Workers => [
		{
			configPath: new URL("../wrangler.jsonc", import.meta.url),
			env: "test",
			prebuiltWorkerDir: new URL("../build/server", import.meta.url),
			secrets: { CTX_PLATFORM_DATABASE_URL: databases.urls.ctx_platform_test },
		},
		{
			configPath: new URL("../../build/wrangler.jsonc", import.meta.url),
			env: "test",
		},
		{
			configPath: new URL("../../dispatcher/wrangler.jsonc", import.meta.url),
			env: "test",
			prebuiltWorkerDir: new URL("../../dispatcher/dist", import.meta.url),
		},
	],
)

test("the build Workflow publishes canonical app, MCP, public, empty, and agent-only sources", async ({
	db,
	harness,
}) => {
	await using temporary = new AsyncDisposableStack()
	const directory = await mkdtemp(join(tmpdir(), "slate-build-"))
	temporary.defer(() => rm(directory, { force: true, recursive: true }))
	const workspace = resolve(import.meta.dirname, "../../..")
	await harness.listen()
	const { AGENTS, ARTIFACTS, DATABASES } = await harness
		.getWorker<PlatformEnv["Bindings"]>("contextlayer-platform-test")
		.getEnv()
	const buildWorker = harness.getWorker<CiBindings & { CTX_DISPATCH_NAMESPACE: string }>(
		"contextlayer-build-test",
	)
	const buildEnv = await buildWorker.getEnv()
	const { SLATES } = await harness
		.getWorker<{ SLATES: DispatchNamespace }>("contextlayer-dispatcher-test")
		.getEnv()
	const execute = execa({
		cwd: directory,
		env: {
			CLOUDFLARE_ACCOUNT_ID: buildEnv.CLOUDFLARE_ACCOUNT_ID,
			CLOUDFLARE_API_TOKEN: buildEnv.CF_TOKEN,
			WRANGLER_SEND_METRICS: "false",
		},
	})
	const namespace = buildEnv.CTX_DISPATCH_NAMESPACE
	for (const source of ["app", "mcp", "public", "empty", "agents"] as const) {
		await using resources = new AsyncDisposableStack()
		const checkout = join(directory, source)
		await mkdir(checkout)
		const slateId = crypto.randomUUID()
		const slate = slateSchema.parse({
			id: slateId,
			owner_organization_id: null,
			owner_user_id: "build-acceptance",
			public_hostname: `${slateId}.contextlayer.xyz`,
			visibility: "private",
		})
		await db.insertInto("slate").values(slate).execute()
		const repo = await ARTIFACTS.create(slate.id)
		resources.defer(async () => {
			await ARTIFACTS.delete(slate.id)
		})
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
		if (source === "app") {
			await createSlateProject(workspace, checkout)
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
				`<p>Static app index ${slate.id}</p>`,
			)
		} else if (source === "mcp") {
			await createSlateProject(workspace, checkout, { scaffold: "mcp" })
			await writeFile(
				join(checkout, "mcp/tool/index.ts"),
				`import { z } from "zod"
export const tool = {
  _meta: { ui: { resourceUri: "ui://tool/index.html" } },
  description: "Echo a number from the built MCP-only Worker.",
  inputSchema: z.object({ value: z.number() }),
  name: "tool",
  outputSchema: z.object({ runtime: z.string(), value: z.number() }),
}
export function handler({ value }: z.infer<typeof tool.inputSchema>) {
  return {
    content: [{ text: String(value), type: "text" as const }],
    structuredContent: { runtime: navigator.userAgent, value },
  }
}
`,
			)
			await mkdir(join(checkout, "mcp-ui/tool"), { recursive: true })
			await writeFile(
				join(checkout, "mcp-ui/tool/index.html"),
				'<p>MCP-only View</p><script type="module" src="./view.ts"></script>',
			)
			await writeFile(
				join(checkout, "mcp-ui/tool/view.ts"),
				'document.documentElement.dataset.proof = "compiled MCP-only View"',
			)
		} else if (source === "public" || source === "agents") {
			await execa(
				process.execPath,
				[join(workspace, "packages/cli/dist/cli.mjs"), "scaffold", source],
				{ cwd: checkout },
			)
			if (source === "public") {
				await mkdir(join(checkout, "public/.well-known"), { recursive: true })
				await writeFile(
					join(checkout, "public/build-proof.bin"),
					new Uint8Array([0, 255, 128]),
				)
				await writeFile(join(checkout, "public/.well-known/proof"), slate.id)
			} else {
				await writeFile(
					join(checkout, "agents/agent/instructions.md"),
					"Assist the user.\n",
				)
				await mkdir(join(checkout, "agents/agent/schedules"))
				await writeFile(
					join(checkout, "agents/agent/schedules/build-proof.md"),
					'---\ncron: "0 0 1 1 *"\n---\nAcknowledge the authored build proof.\n',
				)
			}
		}
		const git = async (...args: string[]) =>
			(
				await execa("git", args, {
					cwd: checkout,
					env: {
						GIT_CONFIG_COUNT: "1",
						GIT_CONFIG_GLOBAL: join(directory, "gitconfig"),
						GIT_CONFIG_KEY_0: "http.extraHeader",
						GIT_CONFIG_VALUE_0: `Authorization: Bearer ${repo.token}`,
						GIT_TERMINAL_PROMPT: "0",
					},
				})
			).stdout.trim()
		await git("init", "-b", "main")
		await git("config", "user.name", "Build Acceptance")
		await git("config", "user.email", "build-acceptance@example.com")
		await git("add", ".")
		await git(
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--allow-empty",
			"-m",
			"Author deployment fixture",
		)
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
		expect(await workflow.getOutput(), source).toEqual({ conclusion: "success" })

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
		expect(bindings, source).toEqual(
			source === "app" || source === "mcp" ? [{ name: "ASSETS", type: "assets" }] : [],
		)
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
			expect(await index.text()).toBe(`<p>Static app index ${slate.id}</p>`)
		} else if (source === "mcp") {
			const response = await deployed.fetch(`https://${slate.public_hostname}/mcp.json`)
			expect(response.status).toBe(200)
			const manifest = mcpManifestSchema.parse(await response.json())
			expect(manifest.tools).toMatchObject([
				{ declaration: { connections: {}, databases: {}, secrets: {} }, name: "tool" },
			])
			expect(manifest.resources).toEqual([
				{
					mimeType: "text/html;profile=mcp-app",
					name: "tool",
					path: "/mcp-ui/tool",
					uri: "ui://tool/index.html",
				},
			])
			const view = await deployed.fetch(`https://${slate.public_hostname}/mcp-ui/tool`)
			expect(view.status).toBe(200)
			expect(await view.text()).toContain("compiled MCP-only View")
			const result = await SLATES.get(slate.id, { props: { mcpTool: "tool" } }).fetch(
				`https://${slate.public_hostname}/mcp`,
				{
					body: JSON.stringify({ value: 42 }),
					headers: { "content-type": "application/json" },
					method: "POST",
				},
			)
			expect(result.status).toBe(200)
			expect(await result.json()).toEqual({
				content: [{ text: "42", type: "text" }],
				structuredContent: {
					runtime: expect.stringContaining("Cloudflare-Workers"),
					value: 42,
				},
			})
		} else if (source === "public") {
			const response = await deployed.fetch(
				`https://${slate.public_hostname}/build-proof.bin`,
			)
			expect(response.status).toBe(200)
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(
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
						prompt: "Acknowledge the authored build proof.\n",
						schedule: "build-proof",
						slateId: slate.id,
					},
					type: "cron",
				},
			])
			expect(await agent.listJobs()).toEqual([])
		}
		if (source === "mcp" || source === "empty" || source === "agents") {
			expect(
				(await deployed.fetch(`https://${slate.public_hostname}/`)).status,
				source,
			).toBe(404)
		}
		for (const path of ["/slate.json", "/app/slate.json"]) {
			expect(
				(await deployed.fetch(`https://${slate.public_hostname}${path}`)).status,
				source,
			).toBe(404)
		}
		console.info("Published canonical source through native build Workflow", {
			slateId,
			source,
		})
	}
}, 1_800_000)
