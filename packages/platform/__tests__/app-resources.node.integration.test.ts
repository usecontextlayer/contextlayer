import { execFile as execFileCallback } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { test } from "@tests/integration"
import { appResourcesSchema } from "@usecontextlayer/shared/app-resources"
import { appSlatesSchema, collectAppResources } from "@usecontextlayer/shared/slate"
import { expect } from "vitest"
import { appSchema } from "@/apps.schema"

const execFile = promisify(execFileCallback)

test("hosted configuration uses pushed declarations independently of developer-local configuration", async ({
	cliEnv,
	db,
	directory: dir,
	identity,
	organization: owningOrganization,
	platform,
}) => {
	const { origin, worker } = platform
	const { headers, user } = identity
	const { ARTIFACTS } = await worker.getEnv()
	await using artifacts = new AsyncDisposableStack()
	const post = (body: unknown) => ({
		body: JSON.stringify(body),
		headers: { ...headers, "content-type": "application/json" },
		method: "POST",
	})
	const apps = []
	for (const body of [{}, { organization_slug: owningOrganization.slug }]) {
		const response = await fetch(`${origin}/api/apps`, post(body))
		expect(response.status).toBe(201)
		const app = appSchema.parse(await response.json())
		artifacts.defer(async () => {
			await ARTIFACTS.delete(app.id)
		})
		apps.push(app)
	}
	const [personal, organization] = apps
	if (!personal || !organization) throw new Error("Expected test apps")
	const publicViewer = await db
		.insertInto("app")
		.values({
			owner_organization_id: null,
			owner_user_id: `test-other-owner-${crypto.randomUUID()}`,
			public_hostname: "public-viewer.example.com",
			visibility: "public",
		})
		.returningAll()
		.executeTakeFirstOrThrow()
	const cli = join(import.meta.dirname, "../../cli/dist/cli.mjs")
	const command = async (...args: string[]) =>
		await execFile(process.execPath, [cli, ...args], {
			cwd: dir,
			env: {
				...process.env,
				...cliEnv,
			},
		})
	const gitEnv = {
		...process.env,
		...cliEnv,
		GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
		GIT_TERMINAL_PROMPT: "0",
	}
	const git = async (...args: string[]) =>
		execFile("git", args, { cwd: dir, env: gitEnv })
	await git(
		"config",
		"--global",
		`credential.${origin}/git.helper`,
		`${cli} git-credential`,
	)
	await mkdir(join(dir, "public"))
	await mkdir(join(dir, "agents/daily-summary"), { recursive: true })
	const declarations = appSlatesSchema.parse({
		agents: {
			"daily-summary": {
				connections: {
					mail: { mode: "viewer", toolkit: "gmail" },
					repository: { mode: "owner", toolkit: "github" },
				},
				folders: { reports: { mode: "owner" } },
				secrets: { MODEL_KEY: { mode: "owner" } },
			},
		},
		app: {
			connections: { mail: { mode: "viewer", toolkit: "gmail" } },
			folders: { priorities: { mode: "viewer" }, reports: { mode: "owner" } },
			secrets: { PERSONAL_KEY: { mode: "viewer" } },
		},
	})
	await writeFile(join(dir, "public/slate.json"), JSON.stringify(declarations.app))
	const agentSlate = join(dir, "agents/daily-summary/slate.json")
	await writeFile(agentSlate, JSON.stringify(declarations.agents["daily-summary"]))
	await git("init", "-b", "main")
	await git("config", "user.name", "Resources Test")
	await git("config", "user.email", "resources-test@example.com")
	await git("remote", "add", "origin", `${origin}/git/${personal.id}`)
	expect((await command("connections", "local", "list")).stdout).toContain("repository")
	await writeFile(
		join(dir, ".contextlayer/connections.json"),
		JSON.stringify({ repository: "developer-local-repository" }),
	)
	await git("add", "public", "agents", ".gitignore")
	await git(
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-m",
		"Declare app and agent resources",
	)
	for (const app of [personal, organization]) {
		await git("remote", "set-url", "origin", `${origin}/git/${app.id}`)
		await git("push", "origin", "main")
		expect((await command("connections", "local", "list")).stdout).toContain("repository")
		expect((await command("connections", "local", "list")).stdout).toContain(
			"developer-local-repository",
		)
		const unassigned = await fetch(
			`${origin}/api/apps/${app.id}/resources/list`,
			post({}),
		)
		expect(unassigned.status).toBe(200)
		expect(
			appResourcesSchema.parse(await unassigned.json()).resources.connections.repository
				?.connection_id,
		).toBeNull()
		expect(
			await db
				.selectFrom("app_connection_assignment")
				.selectAll()
				.where("app_id", "=", app.id)
				.execute(),
		).toEqual([])
		const assigned = await fetch(
			`${origin}/api/apps/${app.id}/connections/assign`,
			post({ connection_id: "test-repository", slug: "repository" }),
		)
		expect(assigned.status).toBe(200)
		expect(
			await db
				.selectFrom("app_connection_assignment")
				.select(["slug", "connection_id", "owner_type", "owner_id"])
				.where("app_id", "=", app.id)
				.execute(),
		).toEqual([
			{
				connection_id: "test-repository",
				owner_id: app === personal ? user.id : owningOrganization.id,
				owner_type: app === personal ? "user" : "organization",
				slug: "repository",
			},
		])
		const response = await fetch(`${origin}/api/apps/${app.id}/resources/list`, post({}))
		expect(response.status).toBe(200)
		const { resources: configuration } = appResourcesSchema.parse(await response.json())
		const viewer = { id: user.id, type: "user" }
		const owner =
			app === personal ? viewer : { id: owningOrganization.id, type: "organization" }
		expect(configuration).toEqual({
			connections: {
				mail: {
					connection_id: null,
					consumers: [{ type: "app" }, { name: "daily-summary", type: "agent" }],
					mode: "viewer",
					owner: viewer,
					toolkit: "gmail",
				},
				repository: {
					connection_id: "test-repository",
					consumers: [{ name: "daily-summary", type: "agent" }],
					mode: "owner",
					owner,
					toolkit: "github",
				},
			},
			folders: {
				priorities: { consumers: [{ type: "app" }], mode: "viewer", owner: viewer },
				reports: {
					consumers: [{ type: "app" }, { name: "daily-summary", type: "agent" }],
					mode: "owner",
					owner,
				},
			},
			secrets: {
				MODEL_KEY: {
					consumers: [{ name: "daily-summary", type: "agent" }],
					mode: "owner",
					owner,
				},
				PERSONAL_KEY: { consumers: [{ type: "app" }], mode: "viewer", owner: viewer },
			},
		})
	}
	await writeFile(
		agentSlate,
		JSON.stringify({
			connections: { calendar: { mode: "viewer", toolkit: "googlecalendar" } },
		}),
	)
	const updated = await command("connections", "local", "list")
	expect(updated.stdout).toContain("calendar")
	expect(updated.stdout).not.toContain("repository")
	for (const app of [personal, organization]) {
		const pushed = await fetch(`${origin}/api/apps/${app.id}/resources/list`, post({}))
		expect(pushed.status).toBe(200)
		const { resources } = appResourcesSchema.parse(await pushed.json())
		expect(resources.connections.repository?.connection_id).toBe("test-repository")
		expect(resources.connections.calendar).toBeUndefined()
		expect(
			(
				await fetch(
					`${origin}/api/apps/${app.id}/resources/list`,
					post({ resources: collectAppResources(declarations) }),
				)
			).status,
		).toBe(400)
	}
	const resources = { connections: {}, folders: {}, secrets: {} }
	expect(
		(
			await fetch(
				`${origin}/api/apps/${publicViewer.id}/resources/list`,
				post({ resources }),
			)
		).status,
	).toBe(400)
	const openapi = await fetch(`${origin}/api/openapi.json`)
	expect(await openapi.text()).toContain('"operationId":"listAppResources"')
	expect(
		(
			await fetch(
				`${origin}/api/apps/${publicViewer.id}/connections/list`,
				post({ resources }),
			)
		).status,
	).toBe(400)
	expect(
		(
			await fetch(
				`${origin}/api/apps/${personal.id}/connections/list`,
				post({ manifest: { connections: {} } }),
			)
		).status,
	).toBe(400)
})
