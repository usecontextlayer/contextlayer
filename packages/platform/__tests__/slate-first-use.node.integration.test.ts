import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { cp, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { provisioningTest as test } from "@tests/integration"
import { signInViewer } from "@usecontextlayer/dev-env/viewer"
import { databaseResultSchema } from "@usecontextlayer/shared/databases"
import { slateResourcesSchema } from "@usecontextlayer/shared/slate-resources"
import { getAgentByName } from "agents/routing"
import { execa } from "execa"
import { expect } from "vitest"
import { getAgentInstanceName } from "@/agent-instance"
import { slateSchema } from "@/slates.schema"

test("first use provisions personal data and schedules once, after the whole slate is complete", {
	timeout: 180_000,
}, async ({
	db,
	directory,
	execution,
	platform,
	provisioning,
	serviceEnv,
	webSession,
}) => {
	const headers = new Headers(webSession.headers)
	headers.set("content-type", "application/json")
	headers.set("origin", platform.origin)
	const created = await fetch(`${platform.origin}/api/slates`, {
		body: "{}",
		headers,
		method: "POST",
	})
	expect(created.status, await created.clone().text()).toBe(201)
	const slate = slateSchema.parse(await created.json())
	const { ARTIFACTS, DATABASES, AGENTS } = await platform.worker.getEnv()
	await using cleanup = new AsyncDisposableStack()
	cleanup.defer(async () => {
		await ARTIFACTS.delete(slate.id)
	})
	const members = () =>
		db
			.selectFrom("slate_member")
			.select("user_id")
			.where("slate_id", "=", slate.id)
			.execute()
	expect(await members()).toEqual([])
	const checkout = join(directory, "first-use")
	await mkdir(join(checkout, "public"), { recursive: true })
	await mkdir(join(checkout, "agents/daily/schedules"), { recursive: true })
	const execute = execa({
		cwd: checkout,
		env: {
			GIT_CONFIG_COUNT: "2",
			GIT_CONFIG_KEY_0: "http.extraHeader",
			GIT_CONFIG_KEY_1: "http.extraHeader",
			GIT_CONFIG_VALUE_0: `Cookie: ${webSession.headers.get("cookie")}`,
			GIT_CONFIG_VALUE_1: `Origin: ${platform.origin}`,
			GIT_TERMINAL_PROMPT: "0",
		},
	})
	const git = (...args: string[]) => execute("git", args)
	await git("init", "-b", "main")
	await git("config", "user.name", "Slate first-use test")
	await git("config", "user.email", "first-use@example.com")
	await git("remote", "add", "origin", `${platform.origin}/git/${slate.id}`)
	await writeFile(
		join(checkout, "public/slate.json"),
		JSON.stringify({
			connections: {},
			databases: { drafts: { mode: "viewer" }, reports: { mode: "owner" } },
		}),
	)
	await writeFile(
		join(checkout, "agents/daily/instructions.md"),
		"Write an update in your declared database.\n",
	)
	await writeFile(
		join(checkout, "agents/daily/schedules/daily.md"),
		'---\ncron: "0 0 1 1 *"\n---\nWrite an update.\n',
	)
	const agentDeclaration = join(checkout, "agents/daily/slate.json")
	await writeFile(
		agentDeclaration,
		JSON.stringify({
			connections: { mail: { mode: "viewer", toolkit: "gmail" } },
			databases: { inbox: { mode: "viewer" } },
		}),
	)
	for (const slug of ["drafts", "inbox", "reports"])
		await cp(
			new URL("../../cli/template/databases/updates/migrations/", import.meta.url),
			join(checkout, "databases", slug, "migrations"),
			{ recursive: true },
		)
	const push = async (message: string) => {
		await git("add", "public", "agents", "databases")
		await git("-c", "commit.gpgsign=false", "commit", "-m", message)
		await git("push", "origin", "main")
	}
	await push("Declare first-use resources")
	const configurationResponse = await fetch(
		`${platform.origin}/api/slates/${slate.id}/resources/list`,
		{ body: "{}", headers, method: "POST" },
	)
	expect(configurationResponse.status, await configurationResponse.clone().text()).toBe(
		200,
	)
	const { resources } = slateResourcesSchema.parse(await configurationResponse.json())
	const reports = resources.databases.reports
	const inbox = resources.databases.inbox
	assert(reports && inbox)
	const { PROVISIONING } = await provisioning.worker.getEnv()
	await PROVISIONING.provision(slate.id)
	expect(await members()).toEqual([])
	expect(
		(await DATABASES.getByName(reports.instance_name).query("SELECT * FROM updates"))
			.rows,
	).toEqual([])
	await expect(
		DATABASES.getByName(inbox.instance_name).query("SELECT * FROM updates"),
	).rejects.toThrow()
	const viewerHeaders = await signInViewer({
		authURL: serviceEnv.addresses.CTX_VIEWER_AUTH_URL.origin,
		returnTo: `https://${slate.public_hostname}/`,
		webHeaders: webSession.headers,
	})
	const token = decodeURIComponent(
		viewerHeaders.get("cookie")?.match(/ctx-viewer-auth=([^;]+)/)?.[1] ?? "",
	)
	assert(token)
	const props = { credential: { token, type: "session" }, slateId: slate.id } as const
	const query = (sql: string, params: (string | number | null)[] = [], slug = "drafts") =>
		execution.worker.fetch("http://execution/databases", {
			body: JSON.stringify([props, [slug, sql, params]]),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
	const agentOnly = await execution.worker.fetch("http://execution/tools", {
		body: JSON.stringify([props, ["mail", "GMAIL_GET_PROFILE", { user_id: "me" }]]),
		headers: { "content-type": "application/json" },
		method: "POST",
	})
	expect(agentOnly.status).toBe(400)
	expect(await agentOnly.json()).toEqual({ error: "not-declared" })
	const privateOwner = await query("SELECT * FROM updates", [], "reports")
	expect(privateOwner.status).toBe(200)
	expect(databaseResultSchema.parse(await privateOwner.json()).rows).toEqual([])
	expect(await members()).toEqual([])
	const missingConnection = await query("SELECT * FROM updates")
	expect(missingConnection.status).toBe(409)
	expect(await missingConnection.json()).toEqual({
		reason: "connection-required",
		slug: "mail",
	})
	expect(await members()).toEqual([])
	const name = `STORY_SECRET_${randomUUID().replaceAll("-", "").toUpperCase()}`
	await writeFile(
		agentDeclaration,
		JSON.stringify({
			connections: {},
			databases: { inbox: { mode: "viewer" } },
			secrets: { [name]: { mode: "viewer" } },
		}),
	)
	await push("Require a viewer secret")
	const missingSecret = await query("SELECT * FROM updates")
	expect(missingSecret.status).toBe(409)
	expect(await missingSecret.json()).toEqual({ name, reason: "secret-required" })
	expect(await members()).toEqual([])
	const explicitJoin = await fetch(`${platform.origin}/api/slates/${slate.id}/join`, {
		headers,
		method: "POST",
	})
	expect(explicitJoin.status).toBe(404)
	expect(await members()).toEqual([])
	const schema = await fetch(`${platform.origin}/api/openapi.json`)
	expect(await schema.json()).not.toHaveProperty(["paths", "/slates/{target}/join"])
	const setVisibility = (visibility: "public" | "private") =>
		fetch(`${platform.origin}/api/slates/${slate.id}`, {
			body: JSON.stringify({ visibility }),
			headers,
			method: "PATCH",
		})
	expect((await setVisibility("public")).status).toBe(200)
	const publicViewer = await query("SELECT * FROM updates")
	expect(publicViewer.status).toBe(400)
	expect(await publicViewer.json()).toEqual({ error: "forbidden" })
	const publicOwner = await query("SELECT * FROM updates", [], "reports")
	expect(publicOwner.status).toBe(200)
	expect(databaseResultSchema.parse(await publicOwner.json()).rows).toEqual([])
	expect(await members()).toEqual([])
	expect((await setVisibility("private")).status).toBe(200)
	await writeFile(
		agentDeclaration,
		JSON.stringify({ connections: {}, databases: { inbox: { mode: "viewer" } } }),
	)
	await push("Complete the input-free slate")
	const first = await query(
		"INSERT INTO updates (id, kind, body, created_at) VALUES (?, ?, ?, ?)",
		["personal", "note", "saved on first use", 1],
	)
	expect(first.status, await first.clone().text()).toBe(200)
	databaseResultSchema.parse(await first.json())
	expect(await members()).toEqual([{ user_id: webSession.user.id }])
	expect(
		(await DATABASES.getByName(inbox.instance_name).query("SELECT * FROM updates")).rows,
	).toEqual([])
	const instance = await getAgentByName(
		AGENTS,
		getAgentInstanceName(slate.id, "daily", { id: webSession.user.id, type: "user" }),
	)
	const schedules = await instance.listSchedules()
	expect(schedules).toHaveLength(1)
	const second = await query("SELECT body FROM updates WHERE id = ?", ["personal"])
	expect(second.status).toBe(200)
	expect(databaseResultSchema.parse(await second.json()).rows).toEqual([
		["saved on first use"],
	])
	expect(await instance.listSchedules()).toEqual(schedules)
	expect(await members()).toEqual([{ user_id: webSession.user.id }])
})
