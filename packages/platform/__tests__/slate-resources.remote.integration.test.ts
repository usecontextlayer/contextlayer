import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { test } from "@tests/integration"
import { copySlateProject } from "@usecontextlayer/dev-env/slate"
import { accountsSchema } from "@usecontextlayer/shared/accounts"
import {
	collectSlateResources,
	slateDeclarationsSchema,
} from "@usecontextlayer/shared/declaration"
import { slateResourcesSchema } from "@usecontextlayer/shared/slate-resources"
import { expect } from "vitest"
import { readSlateDeclarations } from "@/slate-declarations.server"
import { slateSchema } from "@/slates.schema"

const execFile = promisify(execFileCallback)

test("hosted resources report no commit through the API, CLI and chrome", async ({
	cliEnv,
	db,
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
		await db.deleteFrom("slate").where("id", "=", slate.id).execute()
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

test("declaration snapshots follow the selected revision's app and agent source", async ({
	db,
	directory,
	git,
	identity,
	platform,
}) => {
	const { ARTIFACTS } = await platform.worker.getEnv()
	const created = await fetch(`${platform.origin}/api/slates`, {
		headers: identity.headers,
		method: "POST",
	})
	expect(created.status).toBe(201)
	const slate = slateSchema.parse(await created.json())
	await using resources = new AsyncDisposableStack()
	resources.defer(async () => {
		await ARTIFACTS.delete(slate.id)
		await db.deleteFrom("slate").where("id", "=", slate.id).execute()
	})
	await git("init", "-b", "main")
	await git("config", "user.name", "Declaration Test")
	await git("config", "user.email", "declarations-test@example.com")
	await git("remote", "add", "origin", `${platform.origin}/git/${slate.id}`)
	const commitSource = async (message: string) => {
		await git("add", ".")
		await git("-c", "commit.gpgsign=false", "commit", "-m", message)
		await git("push", "origin", "main")
		return (await git("rev-parse", "HEAD")).stdout.trim()
	}
	const readSnapshot = async (revision: string) => {
		using repo = await ARTIFACTS.get(slate.id)
		const commit = await repo.readCommit(revision)
		assert(commit)
		return await readSlateDeclarations(repo, commit)
	}

	await mkdir(join(directory, "public"))
	await writeFile(join(directory, "public/slate.json"), "not a declaration")
	const emptyCommit = await commitSource("Commit static source without consumers")
	const empty = await readSnapshot(emptyCommit)
	expect(empty).toEqual({
		agentTrees: [],
		allowed: true,
		commit: emptyCommit,
		declarations: { agents: {} },
		resources: { connections: {}, databases: {}, secrets: {} },
	})

	await mkdir(join(directory, "agents/summary"), { recursive: true })
	await writeFile(join(directory, "agents/summary/instructions.md"), "Summarize mail.\n")
	await writeFile(
		join(directory, "agents/summary/slate.json"),
		JSON.stringify({ connections: { mail: { mode: "viewer", toolkit: "gmail" } } }),
	)
	const agentCommit = await commitSource("Add a standalone agent")
	const agent = await readSnapshot(agentCommit)
	expect(agent.commit).toBe(agentCommit)
	expect(agent.declarations).toEqual({
		agents: {
			summary: {
				connections: { mail: { mode: "viewer", toolkit: "gmail" } },
				databases: {},
				secrets: {},
			},
		},
	})
	expect(agent.resources.connections.mail).toEqual({
		consumers: [{ name: "summary", type: "agent" }],
		mode: "viewer",
		toolkit: "gmail",
	})

	await mkdir(join(directory, "app"))
	await writeFile(join(directory, "app/root.tsx"), "export default function App() {}")
	const missingDeclaration = await commitSource("Add app source without its declaration")
	await expect(readSnapshot(missingDeclaration)).rejects.toThrow(
		"Slate declaration not found: app/slate.json",
	)
	await writeFile(join(directory, "app/slate.json"), "{")
	const malformedDeclaration = await commitSource("Write an invalid app declaration")
	await expect(readSnapshot(malformedDeclaration)).rejects.toBeInstanceOf(SyntaxError)

	await writeFile(join(directory, "app/slate.json"), JSON.stringify({ connections: {} }))
	const appCommit = await commitSource("Declare the app's empty requirements")
	expect((await readSnapshot(appCommit)).declarations.app).toEqual({
		connections: {},
		databases: {},
		secrets: {},
	})
	expect(await readSnapshot(agentCommit)).toEqual(agent)
	expect(await readSnapshot(emptyCommit)).toEqual(empty)
})

test("hosted configuration uses pushed declarations independently of developer-local configuration", async ({
	cliEnv,
	db,
	directory: dir,
	git,
	identity,
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
	const created = await fetch(`${origin}/api/slates`, post({}))
	expect(created.status).toBe(201)
	const slate = slateSchema.parse(await created.json())
	artifacts.defer(async () => {
		await ARTIFACTS.delete(slate.id)
		await db.deleteFrom("slate").where("id", "=", slate.id).execute()
	})
	const accountsResponse = await fetch(`${origin}/api/accounts?toolkit=gmail`, {
		headers,
	})
	expect(accountsResponse.status).toBe(200)
	const mailAccount = accountsSchema.parse(await accountsResponse.json()).accounts[0]
	if (!mailAccount) throw new Error("Expected an active Gmail connected account")
	const cli = join(import.meta.dirname, "../../cli/dist/cli.mjs")
	const command = async (...args: string[]) =>
		await execFile(process.execPath, [cli, ...args], {
			cwd: dir,
			env: {
				...process.env,
				...cliEnv,
			},
		})
	await copySlateProject(dir)
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
	await git("remote", "add", "origin", `${origin}/git/${slate.id}`)
	await mkdir(join(dir, ".contextlayer"), { recursive: true })
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
	await git("push", "origin", "main")
	const local = await command("connections", "local", "list")
	expect(local.stdout).toContain("repository")
	expect(local.stdout).toContain("developer-local-repository")
	const unassigned = await fetch(
		`${origin}/api/slates/${slate.id}/resources/list`,
		post({}),
	)
	expect(unassigned.status).toBe(200)
	expect(
		slateResourcesSchema.parse(await unassigned.json()).resources.connections.repository
			?.account_id,
	).toBeNull()
	const assigned = await fetch(
		`${origin}/api/slates/${slate.id}/connections/assign`,
		post({ account_id: "test-repository", slug: "repository" }),
	)
	expect(assigned.status).toBe(200)
	const response = await fetch(
		`${origin}/api/slates/${slate.id}/resources/list`,
		post({}),
	)
	expect(response.status).toBe(200)
	const { resources: configuration } = slateResourcesSchema.parse(await response.json())
	const viewer = { id: user.id, type: "personal" }
	const owner = viewer
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
	const html = await chrome.text()
	expect(chrome.headers.get("content-security-policy")).toContain(
		"form-action 'self' https://connect.composio.dev https://dashboard.composio.dev",
	)
	expect(html).toContain("2 inputs to configure")
	expect(html.match(/agent: daily-summary/g)).toHaveLength(2)
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
		slateResourcesSchema.parse(await saved.json()).resources.connections.mail?.account_id,
	).toBe(mailAccount.id)
	await db
		.updateTable("slate")
		.set({ owner_user_id: crypto.randomUUID(), visibility: "public" })
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

	await writeFile(
		agentDeclaration,
		JSON.stringify({
			connections: { calendar: { mode: "viewer", toolkit: "googlecalendar" } },
		}),
	)
	const updated = await command("connections", "local", "list")
	expect(updated.stdout).toContain("calendar")
	expect(updated.stdout).not.toContain("repository")
	const pushed = await fetch(`${origin}/api/slates/${slate.id}/resources/list`, post({}))
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
	const openapi = await fetch(`${origin}/api/openapi.json`)
	expect(await openapi.text()).toContain('"operationId":"listSlateResources"')
})
