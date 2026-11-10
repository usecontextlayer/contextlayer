import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { dispatcherTest as base } from "@tests/integration"
import { copySlateProject } from "@usecontextlayer/dev-env/slate"
import { signInViewer } from "@usecontextlayer/dev-env/viewer"
import { createAuthClient } from "better-auth/client"
import { setCookieToHeader } from "better-auth/cookies"
import postgres from "postgres"
import { expect } from "vitest"
import {
	agentConversationSchema,
	agentConversationsPageSchema,
	agentConversationViewSchema,
	agentSchema,
} from "@/agents.schema"
import { type Slate, slateSchema } from "@/slates.schema"

const test = base.extend(
	"otherWebSession",
	async ({ organization, webEnv }, { onCleanup }) => {
		const resources = new AsyncDisposableStack()
		onCleanup(() => resources.disposeAsync())
		const sql = postgres(webEnv.DATABASE_URL)
		resources.defer(() => sql.end())
		const headers = new Headers({ origin: new URL(webEnv.BETTER_AUTH_URL).origin })
		const client = createAuthClient({
			baseURL: webEnv.BETTER_AUTH_URL,
			fetchOptions: { headers, onSuccess: setCookieToHeader(headers), throw: true },
		})
		const password = crypto.randomUUID()
		const { user } = await client.signUp.email({
			email: `agent-api-${crypto.randomUUID()}@usecontextlayer.com`,
			name: "Agent API isolation",
			password,
		})
		resources.defer(async () => {
			await client.deleteUser({ password })
		})
		// Native invitations send email; this owned prerequisite leaves authorization to web.
		const memberId = crypto.randomUUID()
		await sql`INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
			VALUES (${memberId}, ${organization.id}, ${user.id}, 'member', NOW())`
		resources.defer(async () => {
			await sql`DELETE FROM member WHERE id = ${memberId}`
		})
		return { headers, user }
	},
)

test("the hosted agent API binds the canonical slate and isolates each user's conversations", async ({
	db,
	directory,
	dispatcher,
	git,
	identity,
	organization,
	otherWebSession,
	platform,
	webEnv,
	webSession,
}) => {
	const headers = identity.headers
	const { ARTIFACTS } = await platform.worker.getEnv()
	await using resources = new AsyncDisposableStack()
	const slates: Slate[] = []
	for (let index = 0; index < 2; index++) {
		const created = await fetch(`${platform.origin}/api/slates`, {
			body: JSON.stringify({ organization_slug: organization.slug }),
			headers: { ...headers, "content-type": "application/json" },
			method: "POST",
		})
		expect(created.status).toBe(201)
		const slate = slateSchema.parse(await created.json())
		slates.push(slate)
		resources.defer(async () => {
			await ARTIFACTS.delete(slate.id)
			await db.deleteFrom("slate").where("id", "=", slate.id).execute()
		})
	}
	const [slate, otherSlate] = slates
	assert(slate && otherSlate)
	await copySlateProject(directory, { scaffold: "empty" })
	await mkdir(join(directory, "agents/brief"), { recursive: true })
	const instructions = "Answer briefly.\n"
	await writeFile(join(directory, "agents/brief/instructions.md"), instructions)
	await writeFile(
		join(directory, "agents/brief/slate.json"),
		JSON.stringify({ connections: {} }),
	)
	await git("init", "-b", "main")
	await git("config", "user.name", "Agent API Acceptance")
	await git("config", "user.email", "agent-api-test@example.com")
	await git("add", ".")
	await git("-c", "commit.gpgsign=false", "commit", "-m", "Author hosted API agent")
	for (const slate of slates) {
		await git("push", `${platform.origin}/git/${slate.id}`, "main")
	}
	const commit = (await git("rev-parse", "HEAD")).stdout.trim()
	const agentUrl = `https://${slate.public_hostname}/.ctx/agents/brief`
	const otherAgentUrl = `https://${otherSlate.public_hostname}/.ctx/agents/brief`
	const source = await dispatcher.fetch(agentUrl, { headers })
	expect(source.status).toBe(200)
	expect(agentSchema.parse(await source.json())).toEqual({ commit, instructions })

	const viewerHeaders = await signInViewer({
		authURL: webEnv.CTX_VIEWER_AUTH_URL,
		returnTo: `https://${slate.public_hostname}/`,
		webHeaders: webSession.headers,
	})
	const otherViewerHeaders = await signInViewer({
		authURL: webEnv.CTX_VIEWER_AUTH_URL,
		returnTo: `https://${slate.public_hostname}/`,
		webHeaders: otherWebSession.headers,
	})
	for (const credentials of [viewerHeaders, otherViewerHeaders]) {
		credentials.set("sec-fetch-site", "same-origin")
		credentials.set("sec-fetch-mode", "cors")
		credentials.set("sec-fetch-dest", "empty")
	}
	const created = await dispatcher.fetch(`${agentUrl}/user/conversations`, {
		headers: Object.fromEntries(viewerHeaders),
		method: "POST",
	})
	expect(created.status).toBe(201)
	const conversation = agentConversationSchema.parse(await created.json())
	expect(new URL(created.headers.get("location") ?? "", agentUrl).href).toBe(
		`${agentUrl}/user/conversations/${conversation.id}`,
	)
	const userUrl = `${platform.origin}/api/slates/${slate.id}/agents/brief/user`
	const canonical = await fetch(`${userUrl}/conversations/${conversation.id}`, {
		headers: webSession.headers,
	})
	expect(canonical.status).toBe(200)
	expect(agentConversationViewSchema.parse(await canonical.json()).conversation).toEqual(
		conversation,
	)
	const secondCreated = await fetch(`${userUrl}/conversations`, {
		headers,
		method: "POST",
	})
	expect(secondCreated.status).toBe(201)
	const second = agentConversationSchema.parse(await secondCreated.json())

	for (const [url, credentials] of [
		[agentUrl, otherViewerHeaders],
		[otherAgentUrl, viewerHeaders],
	] as const) {
		const created = await dispatcher.fetch(`${url}/user/conversations`, {
			headers: Object.fromEntries(credentials),
			method: "POST",
		})
		expect(created.status).toBe(201)
		const separate = agentConversationSchema.parse(await created.json())
		const listed = await dispatcher.fetch(`${url}/user/conversations?limit=100`, {
			headers: Object.fromEntries(credentials),
		})
		expect(listed.status).toBe(200)
		const conversations = agentConversationsPageSchema.parse(await listed.json()).items
		expect(conversations).toContainEqual(separate)
		expect(conversations).not.toContainEqual(second)
		const absent = await dispatcher.fetch(`${url}/user/conversations/${second.id}`, {
			headers: Object.fromEntries(credentials),
		})
		expect(absent.status).toBe(404)
	}
	for (const credentials of [Object.fromEntries(viewerHeaders), headers]) {
		const listed = await dispatcher.fetch(`${agentUrl}/user/conversations?limit=100`, {
			headers: credentials,
		})
		expect(listed.status).toBe(200)
		expect(agentConversationsPageSchema.parse(await listed.json()).items).toEqual(
			expect.arrayContaining([conversation, second]),
		)
	}

	const madePublic = await fetch(`${platform.origin}/api/slates/${slate.id}`, {
		body: JSON.stringify({ visibility: "public" }),
		headers: { ...headers, "content-type": "application/json" },
		method: "PATCH",
	})
	expect(madePublic.status).toBe(200)
	expect((await dispatcher.fetch(agentUrl, { headers })).status).toBe(200)
	const schedules = await dispatcher.fetch(`${agentUrl}/app/schedules`, { headers })
	expect(schedules.status).toBe(200)
	expect(await schedules.json()).toEqual([])
})
