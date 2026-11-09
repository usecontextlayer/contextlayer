import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { dispatcherTest as test } from "@tests/integration"
import { copySlateProject } from "@usecontextlayer/dev-env/slate"
import { signInViewer } from "@usecontextlayer/dev-env/viewer"
import { expect } from "vitest"
import {
	agentConversationSchema,
	agentConversationViewSchema,
	agentSchema,
} from "@/agents.schema"
import { slateSchema } from "@/slates.schema"

test("the hosted agent API binds the canonical slate and preserves management policy", async ({
	db,
	directory,
	dispatcher,
	git,
	identity,
	platform,
	webEnv,
	webSession,
}) => {
	const headers = identity.headers
	const createdSlate = await fetch(`${platform.origin}/api/slates`, {
		headers,
		method: "POST",
	})
	expect(createdSlate.status).toBe(201)
	const slate = slateSchema.parse(await createdSlate.json())
	const { ARTIFACTS } = await platform.worker.getEnv()
	await using resources = new AsyncDisposableStack()
	resources.defer(async () => {
		await ARTIFACTS.delete(slate.id)
		await db.deleteFrom("slate").where("id", "=", slate.id).execute()
	})
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
	await git("push", `${platform.origin}/git/${slate.id}`, "main")
	const commit = (await git("rev-parse", "HEAD")).stdout.trim()
	const agentUrl = `https://${slate.public_hostname}/.ctx/agents/brief`
	const source = await dispatcher.fetch(agentUrl, { headers })
	expect(source.status).toBe(200)
	expect(agentSchema.parse(await source.json())).toEqual({ commit, instructions })

	const created = await dispatcher.fetch(`${agentUrl}/user/conversations`, {
		headers,
		method: "POST",
	})
	expect(created.status).toBe(201)
	const conversation = agentConversationSchema.parse(await created.json())
	expect(new URL(created.headers.get("location") ?? "", agentUrl).href).toBe(
		`${agentUrl}/user/conversations/${conversation.id}`,
	)
	const canonical = await fetch(
		`${platform.origin}/api/slates/${slate.id}/agents/brief/user/conversations/${conversation.id}`,
		{ headers },
	)
	expect(canonical.status).toBe(200)
	expect(agentConversationViewSchema.parse(await canonical.json()).conversation).toEqual(
		conversation,
	)

	const viewerHeaders = await signInViewer({
		authURL: webEnv.CTX_VIEWER_AUTH_URL,
		returnTo: `https://${slate.public_hostname}/`,
		webHeaders: webSession.headers,
	})
	expect(
		(
			await dispatcher.fetch(`${agentUrl}/user/conversations?limit=10`, {
				headers: Object.fromEntries(viewerHeaders),
			})
		).status,
	).toBe(401)
	expect(
		(
			await dispatcher.fetch(`${agentUrl}/user/conversations?limit=10`, {
				headers: {
					"Sec-Fetch-Dest": "empty",
					"Sec-Fetch-Mode": "cors",
					"Sec-Fetch-Site": "cross-site",
				},
			})
		).status,
	).toBe(403)

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
	expect(
		(await dispatcher.fetch(`${agentUrl}/user/conversations?limit=10`, { headers }))
			.status,
	).toBe(403)
})
