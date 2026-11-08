import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type Cursor, ToolResultEntry } from "@earendil-works/pi-durable"
import { writeDatabase } from "@tests/database-project"
import { test } from "@tests/integration"
import { copySlateProject } from "@usecontextlayer/dev-env/slate"
import { slateResourcesSchema } from "@usecontextlayer/shared/slate-resources"
import { expect } from "vitest"
import type { z } from "zod"
import { getAgentInstanceName } from "@/agent-instance"
import {
	agentConversationSchema,
	agentEntriesPageSchema,
	type agentEntrySchema,
	agentSubmissionSchema,
} from "@/agents.schema"
import { slateMemberSchema } from "@/slate-members.schema"
import { slateSchema } from "@/slates.schema"

test("API conversations execute Code Mode database calls and retain owner and viewer writes after recovery", async ({
	buildWorker,
	git,
	db,
	directory,
	organization,
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
	const created = await fetch(
		`${origin}/api/slates`,
		post({ organization_slug: organization.slug }),
	)
	expect(created.status).toBe(201)
	const slate = slateSchema.parse(await created.json())
	const { ARTIFACTS, DATABASES } = await worker.getEnv()
	await using resources = new AsyncDisposableStack()
	resources.defer(async () => {
		await ARTIFACTS.delete(slate.id)
	})
	await copySlateProject(directory)
	await mkdir(join(directory, "agents/database"), { recursive: true })
	await writeFile(
		join(directory, "app/slate.json"),
		JSON.stringify({
			connections: {},
			databases: { drafts: { mode: "viewer" }, reports: { mode: "owner" } },
		}),
	)
	await writeFile(
		join(directory, "agents/database/slate.json"),
		JSON.stringify({
			connections: {},
			databases: { drafts: { mode: "viewer" }, reports: { mode: "owner" } },
			secrets: { ANTHROPIC_API_KEY: { mode: "owner" } },
		}),
	)
	await writeFile(
		join(directory, "agents/database/instructions.md"),
		"Use the requested database tool. These are disposable acceptance databases; the requested SQL writes are authorized. Do not use Bash. Report completion briefly.\n",
	)
	for (const database of ["drafts", "reports"]) await writeDatabase(directory, database)
	const sql =
		"INSERT INTO updates (id, kind, body, created_at) SELECT ?, kind, body, ? FROM updates WHERE id = ? RETURNING id, body"
	const copies = ["drafts", "reports"].map((slug) => ({
		params: [`copy-${slug}`, 2, "seed"],
		slug,
		sql,
	}))
	await git("init", "-b", "main")
	await git("config", "user.name", "Pi Database Acceptance")
	await git("config", "user.email", "pi-database-test@example.com")
	await git("add", ".")
	await git("-c", "commit.gpgsign=false", "commit", "-m", "Declare agent databases")
	await git("push", `${origin}/git/${slate.id}`, "main")
	await db
		.insertInto("slate_member")
		.values(slateMemberSchema.parse({ slate_id: slate.id, user_id: webSession.user.id }))
		.execute()
	const { MEMBER_PROVISIONING, PROVISIONING } = await buildWorker.getEnv()
	const prepared = await PROVISIONING.prepare(
		slate.id,
		(await git("rev-parse", "HEAD")).stdout.trim(),
	)
	{
		await using workflow = await buildWorker.introspectWorkflowInstance(
			"MEMBER_PROVISIONING",
			(await MEMBER_PROVISIONING.create({ params: prepared })).id,
		)
		await workflow.waitForStatus("complete")
	}
	const inventory = await fetch(
		`${origin}/api/slates/${slate.id}/resources/list`,
		post({}),
	)
	expect(inventory.status).toBe(200)
	const { databases } = slateResourcesSchema.parse(await inventory.json()).resources
	expect(databases.reports?.owner).toEqual({
		id: organization.id,
		type: "organization",
	})
	expect(databases.drafts?.owner).toEqual({ id: webSession.user.id, type: "personal" })
	const drafts = databases.drafts
	const reports = databases.reports
	assert(drafts && reports)
	const stores = {
		drafts: DATABASES.getByName(drafts.instance_name),
		reports: DATABASES.getByName(reports.instance_name),
	}
	const markers = {
		drafts: `personal-${webSession.user.id}`,
		reports: `org-${organization.id}`,
	}
	for (const slug of ["drafts", "reports"] as const) {
		const database = stores[slug]
		await database.query(
			"INSERT INTO updates (id, kind, body, created_at) VALUES (?, ?, ?, ?)",
			["seed", "proof", markers[slug], 1],
		)
	}
	const url = `${origin}/api/slates/${slate.id}/agents/database`
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
			content: `Use Code Mode to call tools.database_query for each of ${JSON.stringify(copies)}. Copy the seed row in both databases.`,
		}),
	)
	expect(submitted.status).toBe(202)
	let result = agentSubmissionSchema.parse(await submitted.json())
	expect(result.conversationId).toBe(conversation.id)
	const submissionUrl = `${url}/submissions/${result.id}`
	await expect
		.poll(
			async () => {
				const response = await fetch(submissionUrl, { headers })
				expect(response.status).toBe(200)
				result = agentSubmissionSchema.parse(await response.json())
				return result.status === "done" || result.status === "unanswered"
			},
			{ interval: 1000, timeout: 600_000 },
		)
		.toBe(true)
	expect(result.status, result.status === "unanswered" ? result.reason : undefined).toBe(
		"done",
	)
	assert(result.type === "input" && result.status === "done")
	const messages: z.infer<typeof agentEntrySchema>[] = []
	let cursor: Cursor | undefined
	do {
		const entriesUrl = new URL(`${conversationUrl}/entries`)
		entriesUrl.searchParams.set("minEntryId", String(result.entry))
		entriesUrl.searchParams.set("maxEntryId", String(result.answer))
		entriesUrl.searchParams.set("limit", "100")
		if (cursor) entriesUrl.searchParams.set("cursor", JSON.stringify(cursor))
		const response = await fetch(entriesUrl, { headers })
		expect(response.status).toBe(200)
		const page = agentEntriesPageSchema.parse(await response.json())
		messages.push(...page.items)
		cursor = page.next
	} while (cursor)
	const toolResults = messages
		.filter((entry) => entry.kind === ToolResultEntry.kind)
		.flatMap((entry) => entry.model ?? [])
		.filter((message) => message.role === "toolResult" && message.toolName === "codemode")
	expect(toolResults).toContainEqual(
		expect.objectContaining({
			details: expect.objectContaining({
				calls: expect.arrayContaining([
					expect.objectContaining({ name: "database_query", status: "ok" }),
				]),
			}),
			isError: false,
		}),
	)
	await worker.evictDurableObject("SlateAgent", {
		name: getAgentInstanceName(slate.id, "database", {
			id: webSession.user.id,
			type: "user",
		}),
	})
	const recovered = await fetch(submissionUrl, { headers })
	expect(recovered.status).toBe(200)
	expect(agentSubmissionSchema.parse(await recovered.json())).toEqual(result)
	for (const slug of ["drafts", "reports"] as const) {
		const persisted = await stores[slug].query(
			"SELECT id, body FROM updates ORDER BY created_at",
		)
		expect(persisted.rows).toEqual([
			{ body: markers[slug], id: "seed" },
			{ body: markers[slug], id: `copy-${slug}` },
		])
	}
}, 900_000)
