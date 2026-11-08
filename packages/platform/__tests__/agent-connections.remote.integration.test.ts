import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ToolResultEntry } from "@earendil-works/pi-durable"
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode"
import { test } from "@tests/integration"
import { copySlateProject } from "@usecontextlayer/dev-env/slate"
import { accountsSchema } from "@usecontextlayer/shared/accounts"
import { expect } from "vitest"
import { z } from "zod"
import {
	agentConversationSchema,
	agentEntriesPageSchema,
	agentSubmissionSchema,
} from "@/agents.schema"
import { slateSchema } from "@/slates.schema"

test("SlateAgent connection namespaces execute against their assigned Gmail accounts", async ({
	db,
	directory,
	git,
	platform,
	webSession,
}) => {
	const { origin, worker } = platform
	const headers = new Headers(webSession.headers)
	headers.set("origin", origin)
	headers.set("content-type", "application/json")
	const post = (body: unknown) => ({
		body: JSON.stringify(body),
		headers,
		method: "POST",
	})
	const catalog = await fetch(`${origin}/api/accounts?toolkit=gmail`, { headers })
	expect(catalog.status).toBe(200)
	const { accounts } = accountsSchema.parse(await catalog.json())
	const first = accounts[0]
	const second = accounts.find((account) => account.display_name !== first?.display_name)
	if (!first || !second)
		throw new Error("Connect two distinct Gmail accounts to the DevEnv user")
	const assignments = { personal_email: second, work_email: first }
	for (const account of Object.values(assignments)) z.email().parse(account.display_name)
	const created = await fetch(`${origin}/api/slates`, post({}))
	expect(created.status).toBe(201)
	const slate = slateSchema.parse(await created.json())
	const { ARTIFACTS } = await worker.getEnv()
	await using resources = new AsyncDisposableStack()
	resources.defer(async () => {
		await ARTIFACTS.delete(slate.id)
		await db.deleteFrom("slate").where("id", "=", slate.id).execute()
	})
	await copySlateProject(directory, { scaffold: "empty" })
	await mkdir(join(directory, "agents/mail"), { recursive: true })
	await writeFile(
		join(directory, "agents/mail/slate.json"),
		JSON.stringify({
			connections: {
				personal_email: { mode: "viewer", toolkit: "gmail" },
				work_email: { mode: "viewer", toolkit: "gmail" },
			},
			secrets: { ANTHROPIC_API_KEY: { mode: "viewer" } },
		}),
	)
	await writeFile(
		join(directory, "agents/mail/instructions.md"),
		"Use Code Mode for the requested read-only Gmail profile calls. Return their results without substituting mailbox identities. Report completion briefly.\n",
	)
	await git("init", "-b", "main")
	await git("config", "user.name", "Pi Connection Acceptance")
	await git("config", "user.email", "pi-connections-test@example.com")
	await git("add", ".")
	await git("-c", "commit.gpgsign=false", "commit", "-m", "Declare agent connections")
	await git("push", `${origin}/git/${slate.id}`, "main")
	for (const [slug, account] of Object.entries(assignments)) {
		const assigned = await fetch(
			`${origin}/api/slates/${slate.id}/connections/assign`,
			post({ account_id: account.id, slug }),
		)
		expect(assigned.status).toBe(200)
	}
	const url = `${origin}/api/slates/${slate.id}/agents/mail/user`
	const conversationResponse = await fetch(`${url}/conversations`, {
		headers,
		method: "POST",
	})
	expect(conversationResponse.status).toBe(201)
	const conversation = agentConversationSchema.parse(await conversationResponse.json())
	const conversationUrl = `${url}/conversations/${conversation.id}`
	const submitted = await fetch(
		`${conversationUrl}/submissions`,
		post({
			content: `Execute this JavaScript in Code Mode and return its result. Only read Gmail profiles:\nreturn {\n  personal_email: (await tools.personal_email__GMAIL_GET_PROFILE({ user_id: "me" })).data.emailAddress,\n  work_email: (await tools.work_email__GMAIL_GET_PROFILE({ user_id: "me" })).data.emailAddress\n};`,
		}),
	)
	expect(submitted.status).toBe(202)
	let result = agentSubmissionSchema.parse(await submitted.json())
	await expect
		.poll(
			async () => {
				const response = await fetch(`${url}/submissions/${result.id}`, { headers })
				expect(response.status).toBe(200)
				result = agentSubmissionSchema.parse(await response.json())
				return result.status === "done" || result.status === "unanswered"
			},
			{ interval: 1000, timeout: 180_000 },
		)
		.toBe(true)
	expect(result.status, result.status === "unanswered" ? result.reason : undefined).toBe(
		"done",
	)
	assert(result.type === "input" && result.status === "done")
	const history = await fetch(
		`${conversationUrl}/entries?minEntryId=${result.entry}&maxEntryId=${result.answer}&limit=100`,
		{ headers },
	)
	expect(history.status).toBe(200)
	const { items: entries } = agentEntriesPageSchema.parse(await history.json())
	const toolResults = entries
		.filter((entry) => entry.kind === ToolResultEntry.kind)
		.flatMap((entry) => entry.model ?? [])
		.filter(
			(message) =>
				message.role === "toolResult" && message.toolName === CODEMODE_TOOL_NAME,
		)
	for (const [slug, account] of Object.entries(assignments)) {
		expect(toolResults).toContainEqual(
			expect.objectContaining({
				content: expect.arrayContaining([
					expect.objectContaining({
						text: expect.stringContaining(
							`${JSON.stringify(slug)}:${JSON.stringify(account.display_name)}`,
						),
						type: "text",
					}),
				]),
				details: expect.objectContaining({
					calls: expect.arrayContaining([
						expect.objectContaining({ name: `${slug}__GMAIL_GET_PROFILE`, status: "ok" }),
					]),
				}),
				isError: false,
			}),
		)
	}
}, 300_000)
