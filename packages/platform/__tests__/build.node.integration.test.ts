import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { CiParams, CiRunnerResult, CloudflareArtifacts } from "@cloudflare/ci"
import type { CiBindings } from "@cloudflare/ci/worker"
import { test as base } from "@tests/database"
import type { Workers } from "@tests/workers"
import { createSlateProject } from "@usecontextlayer/dev-env/slate"
import { execa } from "execa"
import { expect } from "vitest"
import { z } from "zod"
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
			prebuiltWorkerDir: new URL("../../build/dist", import.meta.url),
		},
		{
			configPath: new URL("../../dispatcher/wrangler.jsonc", import.meta.url),
			env: "test",
			prebuiltWorkerDir: new URL("../../dispatcher/dist", import.meta.url),
		},
	],
)

test("the build Workflow publishes a migrated slate with platform-owned bindings", async ({
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
	const buildWorker = harness.getWorker<CiBindings & { CTX_DISPATCH_NAMESPACE: string }>(
		"contextlayer-build-test",
	)
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

	const wrangler = fileURLToPath(
		new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
	)
	const execute = execa({
		cwd: directory,
		env: {
			CLOUDFLARE_ACCOUNT_ID: buildEnv.CLOUDFLARE_ACCOUNT_ID,
			CLOUDFLARE_API_TOKEN: buildEnv.CF_TOKEN,
			WRANGLER_SEND_METRICS: "false",
		},
	})
	const namespace = buildEnv.CTX_DISPATCH_NAMESPACE
	const seed = join(directory, "seed")
	await mkdir(seed)
	await writeFile(
		join(seed, "index.js"),
		'export default { fetch() { return new Response("previous deployment") } }',
	)
	const seedConfig = join(seed, "wrangler.json")
	await writeFile(
		seedConfig,
		JSON.stringify({
			compatibility_date: "2026-10-19",
			main: "index.js",
			name: slate.id,
		}),
	)
	await execute(process.execPath, [
		wrangler,
		"deploy",
		"--config",
		seedConfig,
		"--env=",
		"--dispatch-namespace",
		namespace,
	])
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
	await execute("pnpm", [
		"dlx",
		"cf",
		"workers-for-platforms",
		"dispatch-namespaces",
		"scripts",
		"secrets",
		"update",
		slate.id,
		"--dispatch-namespace",
		namespace,
		"--name",
		"OLD_SECRET",
		"--type",
		"secret_text",
		"--text",
		"harmless-test-sentinel",
	])
	const bindings = async () => {
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
		return z
			.array(z.object({ name: z.string(), type: z.string() }))
			.parse(JSON.parse(stdout))
	}
	expect(await bindings()).toEqual([{ name: "OLD_SECRET", type: "secret_text" }])
	await execute("pnpm", [
		"dlx",
		"cf",
		"workers-for-platforms",
		"dispatch-namespaces",
		"scripts",
		"secrets",
		"bulk",
		"--dispatch-namespace",
		namespace,
		"--script-name",
		slate.id,
		"--secrets",
		JSON.stringify({ OLD_SECRET: null }),
	])
	expect(await bindings()).toEqual([])

	await createSlateProject(resolve(import.meta.dirname, "../../.."), checkout)
	const packagePath = join(checkout, "package.json")
	const manifest = JSON.parse(await readFile(packagePath, "utf8"))
	manifest.scripts.build = `node ./check-build-env.mjs && ${manifest.scripts.build}`
	await writeFile(packagePath, JSON.stringify(manifest))
	await writeFile(
		join(checkout, "check-build-env.mjs"),
		`const names = ["CF_TOKEN", "CLOUDFLARE_API_TOKEN", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]
if (names.some((name) => process.env[name] !== undefined)) {
  throw new Error("Author build received deployment credentials")
}
`,
	)
	const authorConfigPath = join(checkout, "wrangler.jsonc")
	const authorConfig = JSON.parse(await readFile(authorConfigPath, "utf8"))
	authorConfig.vars = { AUTHOR_SELECTED_BINDING: "not-platform-policy" }
	await writeFile(authorConfigPath, JSON.stringify(authorConfig))
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
	resources.defer(() => buildEnv.BACKUP_BUCKET.delete(`build-artifacts/${id}.tar.gz`))
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

	const database = prepareSlateDatabase(slate, null, "notes", {
		consumers: [{ type: "app" }],
		mode: "owner",
	})
	const notes = DATABASES.getByName(database.instance_name)
	expect((await notes.query("SELECT * FROM notes")).rows).toEqual([])
	expect((await notes.query("SELECT name FROM kysely_migration")).rows).toEqual([
		["001_create_notes"],
	])
	expect(await bindings()).toEqual([{ name: "ASSETS", type: "assets" }])
	const deployed = SLATES.get(slate.id)
	for (const path of ["/build-proof", "/build-proof.txt"]) {
		const response = await deployed.fetch(`https://${slate.public_hostname}${path}`)
		expect(response.status).toBe(200)
		expect(await response.text()).toBe(slate.id)
	}
}, 900_000)
