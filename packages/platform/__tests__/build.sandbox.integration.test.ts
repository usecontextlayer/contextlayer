import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { CiParams, CiRunnerResult, CloudflareArtifacts } from "@cloudflare/ci"
import type { CiBindings } from "@cloudflare/ci/worker"
import { test as base } from "@tests/database"
import { writeDatabase } from "@tests/database-project"
import type { Workers } from "@tests/workers"
import { createSlateProject } from "@usecontextlayer/dev-env/slate"
import { execa } from "execa"
import { expect } from "vitest"
import { z } from "zod"
import type { PlatformEnv } from "@/context"
import type { Provisioning } from "@/provisioning.server"
import { prepareSlateProvisioning } from "@/slate-provisioning.server"
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

test("the build Workflow publishes a migrated slate and its workspace provisions a later member", async ({
	db,
	harness,
}) => {
	await using resources = new AsyncDisposableStack()
	const directory = await mkdtemp(join(tmpdir(), "slate-build-"))
	resources.defer(() => rm(directory, { force: true, recursive: true }))
	const checkout = join(directory, "author")
	await harness.listen()
	const { ARTIFACTS, DATABASES } = await harness
		.getWorker<PlatformEnv["Bindings"]>("contextlayer-platform-test")
		.getEnv()
	const buildWorker = harness.getWorker<
		CiBindings & {
			CTX_DISPATCH_NAMESPACE: string
			MEMBER_PROVISIONING: PlatformEnv["Bindings"]["MEMBER_PROVISIONING"]
			PROVISIONING: Service<Provisioning>
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
		public_hostname: "build-acceptance.contextlayer.xyz",
		visibility: "private",
	})
	await db.insertInto("slate").values(slate).execute()
	const repo = await ARTIFACTS.create(slate.id)
	resources.defer(async () => {
		await ARTIFACTS.delete(slate.id)
	})
	resources.defer(async () => {
		const page = await buildEnv.BACKUP_BUCKET.list({ prefix: `cache/build/${slate.id}/` })
		if (page.objects.length > 0)
			await buildEnv.BACKUP_BUCKET.delete(page.objects.map(({ key }) => key))
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
	await createSlateProject(resolve(import.meta.dirname, "../../.."), checkout)
	await writeFile(
		join(checkout, "public/slate.json"),
		JSON.stringify({
			connections: {},
			databases: { drafts: { mode: "viewer" }, notes: { mode: "owner" } },
			secrets: {},
		}),
	)
	await appendFile(
		join(checkout, "vite.config.ts"),
		`\nimport { writeFileSync } from "node:fs"\nwriteFileSync("build-workspace.txt", ${JSON.stringify(slate.id)})\n`,
	)
	await writeDatabase(checkout, "drafts")
	await writeFile(
		join(checkout, "databases/drafts/migrations/001_create_updates.ts"),
		`import { readFileSync } from "node:fs"
import { sql, type Kysely } from "kysely"
export async function up(db: Kysely<unknown>) {
  const built = readFileSync("build-workspace.txt", "utf8")
  await sql\`CREATE TABLE build_workspace (value TEXT NOT NULL)\`.execute(db)
  await sql\`INSERT INTO build_workspace (value) VALUES (\${built})\`.execute(db)
}
`,
	)
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
	const { snapshot } = (await workflow.waitForStepResult({ name: "build" })) as Pick<
		CiRunnerResult,
		"snapshot"
	>
	resources.defer(() =>
		buildEnv.BACKUP_BUCKET.delete([
			`backups/${snapshot.id}/data.sqsh`,
			`backups/${snapshot.id}/meta.json`,
		]),
	)
	await workflow.waitForStatus("complete")
	expect(await workflow.getOutput()).toEqual({ conclusion: "success" })
	const member = { id: crypto.randomUUID(), type: "user" } as const
	const prepared = await buildEnv.PROVISIONING.prepare(
		slate.id,
		await git("rev-parse", "HEAD"),
	)
	const memberProvisioning = await buildEnv.MEMBER_PROVISIONING.create({
		params: prepareSlateProvisioning(slate, [member], prepared.snapshot),
	})
	await using memberWorkflow = await buildWorker.introspectWorkflowInstance(
		"MEMBER_PROVISIONING",
		memberProvisioning.id,
	)
	await memberWorkflow.waitForStatus("complete")
	const drafts = prepareSlateDatabase(slate, member, "drafts", {
		consumers: [{ type: "app" }],
		mode: "viewer",
	})
	expect(
		(
			await DATABASES.getByName(drafts.instance_name).query(
				"SELECT * FROM build_workspace",
			)
		).rows,
	).toEqual([{ value: slate.id }])

	const database = prepareSlateDatabase(slate, null, "notes", {
		consumers: [{ type: "app" }],
		mode: "owner",
	})
	const notes = DATABASES.getByName(database.instance_name)
	expect((await notes.query("SELECT * FROM notes")).rows).toEqual([])
	expect((await notes.query("SELECT name FROM kysely_migration")).rows).toEqual([
		{ name: "001_create_notes" },
	])
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
	expect(bindings).toEqual([{ name: "ASSETS", type: "assets" }])
	const deployed = SLATES.get(slate.id)
	for (const path of ["/build-proof", "/build-proof.txt"]) {
		const response = await deployed.fetch(`https://${slate.public_hostname}${path}`)
		expect(response.status).toBe(200)
		expect(await response.text()).toBe(slate.id)
	}
}, 900_000)
