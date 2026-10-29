import { execFile as execFileCallback } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { test } from "@tests/integration"
import { accountsSchema } from "@usecontextlayer/shared/accounts"
import {
	collectSlateResources,
	slateDeclarationsSchema,
} from "@usecontextlayer/shared/declaration"
import { slateResourcesSchema } from "@usecontextlayer/shared/slate-resources"
import { expect } from "vitest"
import { slateSchema } from "@/slates.schema"

const execFile = promisify(execFileCallback)

test("hosted resources report no commit through the API, CLI and chrome", async ({
	cliEnv,
	identity,
	platform,
}) => {
	const { origin, worker } = platform
	const { headers } = identity
	const { ARTIFACTS } = await worker.getEnv()
	await using artifacts = new AsyncDisposableStack()
	const post = (body: unknown) => ({
		body: JSON.stringify(body),
		headers: { ...headers, "content-type": "application/json" },
		method: "POST",
	})
	const created = await fetch(`${origin}/api/slates`, post({}))
	expect(created.status).toBe(201)
	const slate = slateSchema.parse(await created.json())
	artifacts.defer(async () => {
		await ARTIFACTS.delete(slate.id)
	})
	for (const [operation, body] of [
		["resources/list", {}],
		["connections/list", {}],
		["connections/assign", { account_id: "test-account", slug: "mail" }],
	] as const) {
		const response = await fetch(
			`${origin}/api/slates/${slate.id}/${operation}`,
			post(body),
		)
		expect(response.status).toBe(409)
		expect(await response.json()).toEqual({ reason: "no-commit" })
	}
	const message = "Nothing has been pushed to this slate yet."
	const cli = join(import.meta.dirname, "../../cli/dist/cli.mjs")
	for (const args of [
		["connections", slate.id, "list"],
		["connections", slate.id, "assign", "mail", "test-account"],
	]) {
		await expect(
			execFile(process.execPath, [cli, ...args], {
				env: { ...process.env, ...cliEnv },
			}),
		).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(message) })
	}
	const chromeUrl = new URL(`/dashboard/chrome/slates/${slate.id}`, origin)
	chromeUrl.searchParams.set("parentOrigin", `https://${slate.public_hostname}`)
	const chrome = await fetch(chromeUrl, { headers: { ...headers, accept: "text/html" } })
	expect(chrome.status).toBe(200)
	expect(await chrome.text()).toContain(message)
})

test("hosted declarations follow the selected commit's app and agent directories", async ({
	db,
	directory,
	identity,
	platform,
	provisioning,
}) => {
	const { ARTIFACTS } = await platform.worker.getEnv()
	const { PROVISIONING } = await provisioning.worker.getEnv()
	const slateId = slateSchema.shape.id.parse(crypto.randomUUID())
	await db
		.insertInto("slate")
		.values(
			slateSchema.parse({
				id: slateId,
				owner_organization_id: null,
				owner_user_id: identity.user.id,
				public_hostname: `declarations-${slateId}.example.com`,
				visibility: "private",
			}),
		)
		.execute()
	const repo = await ARTIFACTS.create(slateId, { setDefaultBranch: "main" })
	await using artifacts = new AsyncDisposableStack()
	artifacts.defer(async () => {
		await ARTIFACTS.delete(slateId)
	})
	const git = async (...args: string[]) =>
		(
			await execFile("git", args, {
				cwd: directory,
				env: {
					...process.env,
					GIT_CONFIG_COUNT: "1",
					GIT_CONFIG_GLOBAL: join(directory, "gitconfig"),
					GIT_CONFIG_KEY_0: "http.extraHeader",
					GIT_CONFIG_VALUE_0: `Authorization: Bearer ${repo.token}`,
					GIT_TERMINAL_PROMPT: "0",
				},
			})
		).stdout.trim()
	const push = async () => {
		await git("add", ".")
		await git("-c", "commit.gpgsign=false", "commit", "-m", "Update declaration sources")
		await git("push", repo.remote, "main")
		return git("rev-parse", "HEAD")
	}
	await git("init", "-b", "main")
	await git("config", "user.name", "Declaration Test")
	await git("config", "user.email", "declarations-test@example.com")
	const noCommit = await fetch(
		`${platform.origin}/api/slates/${slateId}/resources/list`,
		{
			body: "{}",
			headers: { ...identity.headers, "content-type": "application/json" },
			method: "POST",
		},
	)
	expect(noCommit.status).toBe(409)
	expect(await noCommit.json()).toEqual({ reason: "no-commit" })
	await mkdir(join(directory, "public"))
	await writeFile(join(directory, "public/slate.json"), "malformed legacy declaration")
	const emptyCommit = await push()
	const empty = (await PROVISIONING.prepare(slateId, emptyCommit)).snapshot
	expect(empty).toEqual({
		agentTrees: [],
		allowed: true,
		commit: emptyCommit,
		declarations: { agents: {} },
		resources: { connections: {}, databases: {}, secrets: {} },
	})

	await mkdir(join(directory, "agents/summary"), { recursive: true })
	await writeFile(
		join(directory, "agents/summary/slate.json"),
		JSON.stringify({ connections: { mail: { mode: "viewer", toolkit: "gmail" } } }),
	)
	const agentCommit = await push()
	const agent = (await PROVISIONING.prepare(slateId, agentCommit)).snapshot
	expect(agent.declarations).toEqual({
		agents: {
			summary: {
				connections: { mail: { mode: "viewer", toolkit: "gmail" } },
				databases: {},
				secrets: {},
			},
		},
	})
	expect(agent.agentTrees).toEqual([
		{ hash: expect.any(String), mode: "40000", name: "summary", type: "tree" },
	])
	expect(agent.resources).toEqual({
		connections: {
			mail: {
				consumers: [{ name: "summary", type: "agent" }],
				mode: "viewer",
				toolkit: "gmail",
			},
		},
		databases: {},
		secrets: {},
	})

	await mkdir(join(directory, "app"))
	await writeFile(join(directory, "app/root.tsx"), "export default function App() {}")
	const missingDeclarationCommit = await push()
	await expect(async () =>
		PROVISIONING.prepare(slateId, missingDeclarationCommit),
	).rejects.toThrow("Slate declaration not found: app/slate.json")
	for (const declaration of ["{", JSON.stringify({ connections: { mail: {} } })]) {
		await writeFile(join(directory, "app/slate.json"), declaration)
		const invalidDeclarationCommit = await push()
		await expect(async () =>
			PROVISIONING.prepare(slateId, invalidDeclarationCommit),
		).rejects.toThrow()
	}
	await writeFile(join(directory, "app/slate.json"), JSON.stringify({ connections: {} }))
	const appCommit = await push()
	expect(
		(await PROVISIONING.prepare(slateId, appCommit)).snapshot.declarations.app,
	).toEqual({
		connections: {},
		databases: {},
		secrets: {},
	})
	expect((await PROVISIONING.prepare(slateId, agentCommit)).snapshot).toEqual(agent)
	expect((await PROVISIONING.prepare(slateId, emptyCommit)).snapshot).toEqual(empty)
})

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
	const slates = []
	for (const body of [{}, { organization_slug: owningOrganization.slug }]) {
		const response = await fetch(`${origin}/api/slates`, post(body))
		expect(response.status).toBe(201)
		const slate = slateSchema.parse(await response.json())
		artifacts.defer(async () => {
			await ARTIFACTS.delete(slate.id)
		})
		slates.push(slate)
	}
	const [personal, organization] = slates
	if (!personal || !organization) throw new Error("Expected test slates")
	const accountsResponse = await fetch(`${origin}/api/accounts?toolkit=gmail`, {
		headers,
	})
	expect(accountsResponse.status).toBe(200)
	const mailAccount = accountsSchema.parse(await accountsResponse.json()).accounts[0]
	if (!mailAccount) throw new Error("Expected an active Gmail connected account")
	const publicViewer = await db
		.insertInto("slate")
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
	const listedAccounts = await command("accounts", "list")
	expect(listedAccounts.stdout).toContain("ACTIVE")
	expect(listedAccounts.stdout).not.toContain("EXPIRED")
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
	await mkdir(join(dir, "app"))
	await mkdir(join(dir, "agents/daily-summary"), { recursive: true })
	const secretSuffix = crypto.randomUUID().replaceAll("-", "").toUpperCase()
	const ownerSecretName = `CTX_RESOURCES_OWNER_${secretSuffix}`
	const viewerSecretName = `CTX_RESOURCES_VIEWER_${secretSuffix}`
	const declarations = slateDeclarationsSchema.parse({
		agents: {
			"daily-summary": {
				connections: {
					mail: { mode: "viewer", toolkit: "gmail" },
					repository: { mode: "owner", toolkit: "github" },
				},
				databases: { reports: { mode: "owner" } },
				secrets: { [ownerSecretName]: { mode: "owner" } },
			},
		},
		app: {
			connections: { mail: { mode: "viewer", toolkit: "gmail" } },
			databases: { priorities: { mode: "viewer" }, reports: { mode: "owner" } },
			secrets: { [viewerSecretName]: { mode: "viewer" } },
		},
	})
	await writeFile(join(dir, "app/slate.json"), JSON.stringify(declarations.app))
	const agentDeclaration = join(dir, "agents/daily-summary/slate.json")
	await writeFile(agentDeclaration, JSON.stringify(declarations.agents["daily-summary"]))
	await git("init", "-b", "main")
	await git("config", "user.name", "Resources Test")
	await git("config", "user.email", "resources-test@example.com")
	await git("remote", "add", "origin", `${origin}/git/${personal.id}`)
	expect((await command("connections", "local", "list")).stdout).toContain("repository")
	await writeFile(
		join(dir, ".contextlayer/connections.json"),
		JSON.stringify({ repository: "developer-local-repository" }),
	)
	await git("add", "app", "agents")
	await git(
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-m",
		"Declare app and agent resources",
	)
	for (const slate of [personal, organization]) {
		await git("remote", "set-url", "origin", `${origin}/git/${slate.id}`)
		await git("push", "origin", "main")
		expect((await command("connections", "local", "list")).stdout).toContain("repository")
		expect((await command("connections", "local", "list")).stdout).toContain(
			"developer-local-repository",
		)
		const unassigned = await fetch(
			`${origin}/api/slates/${slate.id}/resources/list`,
			post({}),
		)
		expect(unassigned.status).toBe(200)
		expect(
			slateResourcesSchema.parse(await unassigned.json()).resources.connections.repository
				?.account_id,
		).toBeNull()
		expect(
			await db
				.selectFrom("slate_connection_assignment")
				.selectAll()
				.where("slate_id", "=", slate.id)
				.execute(),
		).toEqual([])
		const assigned = await fetch(
			`${origin}/api/slates/${slate.id}/connections/assign`,
			post({ account_id: "test-repository", slug: "repository" }),
		)
		expect(assigned.status).toBe(200)
		expect(
			await db
				.selectFrom("slate_connection_assignment")
				.select(["slug", "account_id", "owner_type", "owner_id"])
				.where("slate_id", "=", slate.id)
				.execute(),
		).toEqual([
			{
				account_id: "test-repository",
				owner_id: slate === personal ? user.id : owningOrganization.id,
				owner_type: slate === personal ? "personal" : "organization",
				slug: "repository",
			},
		])
		const response = await fetch(
			`${origin}/api/slates/${slate.id}/resources/list`,
			post({}),
		)
		expect(response.status).toBe(200)
		const { resources: configuration } = slateResourcesSchema.parse(await response.json())
		const viewer = { id: user.id, type: "personal" }
		const owner =
			slate === personal ? viewer : { id: owningOrganization.id, type: "organization" }
		expect(configuration).toEqual({
			connections: {
				mail: {
					account_id: null,
					consumers: [{ type: "app" }, { name: "daily-summary", type: "agent" }],
					mode: "viewer",
					owner: viewer,
					toolkit: "gmail",
				},
				repository: {
					account_id: "test-repository",
					consumers: [{ name: "daily-summary", type: "agent" }],
					mode: "owner",
					owner,
					toolkit: "github",
				},
			},
			databases: {
				priorities: {
					consumers: [{ type: "app" }],
					instance_name: expect.stringMatching(/.+/),
					mode: "viewer",
					owner: viewer,
				},
				reports: {
					consumers: [{ type: "app" }, { name: "daily-summary", type: "agent" }],
					instance_name: expect.stringMatching(/.+/),
					mode: "owner",
					owner,
				},
			},
			secrets: {
				[ownerSecretName]: {
					consumers: [{ name: "daily-summary", type: "agent" }],
					mode: "owner",
					owner,
				},
				[viewerSecretName]: {
					consumers: [{ type: "app" }],
					mode: "viewer",
					owner: viewer,
					supplied: false,
				},
			},
		})
		const chromeUrl = new URL(`/dashboard/chrome/slates/${slate.id}`, origin)
		chromeUrl.searchParams.set("parentOrigin", `https://${slate.public_hostname}`)
		const chromeHeaders = { ...headers, accept: "text/html" }
		const chrome = await fetch(chromeUrl, { headers: chromeHeaders })
		expect(chrome.status).toBe(200)
		expect(chrome.headers.get("content-security-policy")).toContain(
			"form-action 'self' https://connect.composio.dev https://dashboard.composio.dev",
		)
		const html = await chrome.text()
		expect(html).toContain("2 inputs to configure")
		expect(html.match(/agent: daily-summary/g)).toHaveLength(2)
		expect(html).not.toContain("Used by")
		expect(html.match(/Configure accounts for mail/g)).toHaveLength(1)
		expect(html.match(/Configure accounts for repository/g)).toHaveLength(1)
		expect(html).toContain(viewerSecretName)
		for (const name of [ownerSecretName, "priorities", "reports"])
			expect(html).not.toContain(name)
		const chromeAssigned = await fetch(chromeUrl, {
			body: new URLSearchParams({
				account_id: mailAccount.id,
				intent: "assign",
				slug: "mail",
			}),
			headers: chromeHeaders,
			method: "POST",
		})
		expect(chromeAssigned.status).toBe(200)
		expect(await chromeAssigned.text()).toContain("1 input to configure")
		const saved = await fetch(`${origin}/api/slates/${slate.id}/resources/list`, post({}))
		expect(saved.status).toBe(200)
		expect(
			slateResourcesSchema.parse(await saved.json()).resources.connections.mail
				?.account_id,
		).toBe(mailAccount.id)
		if (slate === personal) {
			await db
				.updateTable("slate")
				.set({ owner_user_id: publicViewer.owner_user_id, visibility: "public" })
				.where("id", "=", slate.id)
				.execute()
			const viewerChrome = await fetch(chromeUrl, { headers: chromeHeaders })
			expect(viewerChrome.status).toBe(200)
			expect(await viewerChrome.text()).toContain("Managed by slate Owner")
			const denied = await fetch(chromeUrl, {
				body: new URLSearchParams({
					account_id: mailAccount.id,
					intent: "assign",
					slug: "repository",
				}),
				headers: chromeHeaders,
				method: "POST",
			})
			expect(denied.status).toBe(403)
			await db
				.updateTable("slate")
				.set({ owner_user_id: user.id, visibility: "private" })
				.where("id", "=", slate.id)
				.execute()
		}
	}
	await writeFile(
		agentDeclaration,
		JSON.stringify({
			connections: { calendar: { mode: "viewer", toolkit: "googlecalendar" } },
		}),
	)
	const updated = await command("connections", "local", "list")
	expect(updated.stdout).toContain("calendar")
	expect(updated.stdout).not.toContain("repository")
	for (const slate of [personal, organization]) {
		const pushed = await fetch(
			`${origin}/api/slates/${slate.id}/resources/list`,
			post({}),
		)
		expect(pushed.status).toBe(200)
		const { resources } = slateResourcesSchema.parse(await pushed.json())
		expect(resources.connections.repository?.account_id).toBe("test-repository")
		expect(resources.connections.calendar).toBeUndefined()
		expect(
			(
				await fetch(
					`${origin}/api/slates/${slate.id}/resources/list`,
					post({ resources: collectSlateResources(declarations) }),
				)
			).status,
		).toBe(400)
	}
	const resources = { connections: {}, databases: {}, secrets: {} }
	expect(
		(
			await fetch(
				`${origin}/api/slates/${publicViewer.id}/resources/list`,
				post({ resources }),
			)
		).status,
	).toBe(400)
	const openapi = await fetch(`${origin}/api/openapi.json`)
	expect(await openapi.text()).toContain('"operationId":"listSlateResources"')
	expect(
		(
			await fetch(
				`${origin}/api/slates/${publicViewer.id}/connections/list`,
				post({ resources }),
			)
		).status,
	).toBe(400)
	expect(
		(
			await fetch(
				`${origin}/api/slates/${personal.id}/connections/list`,
				post({ declaration: { connections: {} } }),
			)
		).status,
	).toBe(400)
})
