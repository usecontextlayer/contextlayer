import assert from "node:assert/strict"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AssistantEntry, LiveDoc } from "@earendil-works/pi-durable"
import { test } from "@tests/integration"
import { copySlateProject } from "@usecontextlayer/dev-env/slate"
import { expect } from "vitest"
import { z } from "zod"
import {
	agentConversationSchema,
	agentConversationsPageSchema,
	agentConversationViewSchema,
	agentEntriesPageSchema,
	agentRuntimeScheduleSchema,
} from "@/agents.schema"
import { slateSchema } from "@/slates.schema"

test("authored cron firings create separate conversations and retain results after schedule removal and Durable Object eviction", async ({
	buildWorker,
	git,
	directory,
	platform,
	webSession,
}) => {
	const { origin, worker } = platform
	const headers = new Headers(webSession.headers)
	headers.set("origin", origin)
	headers.set("content-type", "application/json")
	const created = await fetch(`${origin}/api/slates`, {
		body: JSON.stringify({}),
		headers,
		method: "POST",
	})
	expect(created.status).toBe(201)
	const slate = slateSchema.parse(await created.json())
	const { ARTIFACTS } = await worker.getEnv()
	await using resources = new AsyncDisposableStack()
	resources.defer(async () => {
		await ARTIFACTS.delete(slate.id)
	})
	const remote = `${origin}/git/${slate.id}`
	await copySlateProject(directory)
	await mkdir(join(directory, "agents/brief/schedules"), { recursive: true })
	await writeFile(join(directory, "app/slate.json"), JSON.stringify({ connections: {} }))
	await writeFile(
		join(directory, "agents/brief/slate.json"),
		JSON.stringify({
			connections: {},
			secrets: { ANTHROPIC_API_KEY: { mode: "owner" } },
		}),
	)
	await writeFile(
		join(directory, "agents/brief/instructions.md"),
		"Answer briefly without using tools.\n",
	)
	// Recurrence keeps the scenario independent of how long setup takes.
	const cron = "*/10 * * * * *"
	const prompt = "Say hello in one sentence."
	await writeFile(
		join(directory, "agents/brief/schedules/greeting.md"),
		`---\ncron: "${cron}"\n---\n${prompt}\n`,
	)
	await git("init", "-b", "main")
	await git("config", "user.name", "Pi Cron Acceptance")
	await git("config", "user.email", "pi-cron-test@example.com")
	await git("add", ".")
	await git(
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-m",
		"Author scheduled Pi acceptance agent",
	)
	await git("push", remote, "main")
	const agentUrl = `${origin}/api/slates/${slate.id}/agents/brief`
	const url = `${agentUrl}/app`
	const userUrl = `${agentUrl}/user`
	const conversationsUrl = `${url}/conversations?limit=100&order=ascending`
	const before = await fetch(conversationsUrl, { headers })
	expect(before.status).toBe(200)
	const beforeConversations = agentConversationsPageSchema.parse(
		await before.json(),
	).items
	const userBefore = await fetch(`${userUrl}/conversations?limit=100`, { headers })
	expect(userBefore.status).toBe(200)
	const userConversations = agentConversationsPageSchema.parse(await userBefore.json())
	const { MEMBER_PROVISIONING, PROVISIONING } = await buildWorker.getEnv()
	const commit = (await git("rev-parse", "HEAD")).stdout.trim()
	await writeFile(
		join(directory, "agents/brief/schedules/greeting.md"),
		'---\ncron: "0 0 1 1 *"\n---\nThis prompt belongs to a later push.\n',
	)
	await git("add", "agents")
	await git("-c", "commit.gpgsign=false", "commit", "-m", "Push a later schedule")
	await git("push", remote, "main")
	const prepared = await PROVISIONING.prepare(slate.id, commit)
	{
		await using workflow = await buildWorker.introspectWorkflowInstance(
			"MEMBER_PROVISIONING",
			(await MEMBER_PROVISIONING.create({ params: prepared })).id,
		)
		await workflow.waitForStatus("complete")
	}
	const scheduleUrl = `${url}/schedules`
	const scheduled = await fetch(scheduleUrl, { headers })
	expect(scheduled.status).toBe(200)
	const schedules = z.array(agentRuntimeScheduleSchema).parse(await scheduled.json())
	expect(schedules).toHaveLength(1)
	const schedule = schedules[0]
	if (!schedule) throw new Error("Expected the authored native cron schedule")
	expect(schedule).toMatchObject({
		callback: "runScheduled",
		cron,
		payload: {
			actor: { type: "app" },
			name: "brief",
			prompt: expect.stringContaining(prompt),
			schedule: "greeting",
			slateId: slate.id,
		},
		type: "cron",
	})
	const scheduleDetail = await fetch(`${scheduleUrl}/${schedule.id}`, { headers })
	expect(scheduleDetail.status).toBe(200)
	expect(agentRuntimeScheduleSchema.parse(await scheduleDetail.json())).toEqual(schedule)
	const userSchedules = await fetch(`${userUrl}/schedules`, { headers })
	expect(userSchedules.status).toBe(200)
	expect(await userSchedules.json()).toEqual([])
	expect((await fetch(`${userUrl}/schedules/${schedule.id}`, { headers })).status).toBe(
		404,
	)
	const madePublic = await fetch(`${origin}/api/slates/${slate.id}`, {
		body: JSON.stringify({ visibility: "public" }),
		headers,
		method: "PATCH",
	})
	expect(madePublic.status).toBe(200)
	expect((await fetch(scheduleUrl, { headers })).status).toBe(200)
	expect((await fetch(`${scheduleUrl}/${schedule.id}`, { headers })).status).toBe(200)
	expect((await fetch(conversationsUrl, { headers })).status).toBe(403)
	const madePrivate = await fetch(`${origin}/api/slates/${slate.id}`, {
		body: JSON.stringify({ visibility: "private" }),
		headers,
		method: "PATCH",
	})
	expect(madePrivate.status).toBe(200)
	let conversations: z.infer<typeof agentConversationsPageSchema>["items"] = []
	await expect
		.poll(
			async () => {
				const response = await fetch(conversationsUrl, { headers })
				expect(response.status).toBe(200)
				conversations = agentConversationsPageSchema
					.parse(await response.json())
					.items.filter(
						(conversation) =>
							!beforeConversations.some((before) => before.id === conversation.id),
					)
				return conversations.length >= 2
			},
			{ interval: 1000, timeout: 180_000 },
		)
		.toBe(true)
	const first = conversations[0]
	const second = conversations[1]
	assert(first && second)
	expect(first.id).not.toBe(second.id)
	await rm(join(directory, "agents/brief/schedules/greeting.md"))
	await git("add", "agents")
	await git(
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-m",
		"Remove the dispatched schedule",
	)
	await git("push", remote, "main")
	await PROVISIONING.provisionSchedules(
		await PROVISIONING.prepare(slate.id, (await git("rev-parse", "HEAD")).stdout.trim()),
	)
	const removed = await fetch(`${scheduleUrl}/${schedule.id}`, { headers })
	expect(removed.status).toBe(404)
	const userCreated = await fetch(`${userUrl}/conversations`, { headers, method: "POST" })
	expect(userCreated.status).toBe(201)
	const userConversation = agentConversationSchema.parse(await userCreated.json())
	expect(userConversation.id).toBe(first.id)
	const completedConversations = []
	for (const [index, conversation] of [first, second].entries()) {
		const conversationUrl = `${url}/conversations/${conversation.id}`
		let view: z.infer<typeof agentConversationViewSchema> | undefined
		await expect
			.poll(
				async () => {
					const response = await fetch(conversationUrl, { headers })
					expect(response.status).toBe(200)
					view = agentConversationViewSchema.parse(await response.json())
					const live = view.docs[LiveDoc.definition.kind]
					return (
						live?.runFailure !== undefined ||
						(live?.run === undefined &&
							view.entries.some((entry) => entry.kind === AssistantEntry.kind))
					)
				},
				{ interval: 1000, timeout: 120_000 },
			)
			.toBe(true)
		assert(view)
		expect(view.conversation).toEqual(conversation)
		expect(
			view.docs[LiveDoc.definition.kind]?.runFailure,
			JSON.stringify(view.docs[LiveDoc.definition.kind]),
		).toBeUndefined()
		expect(view.docs[LiveDoc.definition.kind]?.run).toBeUndefined()
		if (index === 0) {
			const input = view.entries.find((entry) => entry.kind === "slate.schedule")
			assert(input)
			for (const [instanceUrl, expected] of [
				[url, [input]],
				[userUrl, []],
			] as const) {
				const selected = await fetch(
					`${instanceUrl}/conversations/${userConversation.id}/entries?minEntryId=${input.id}&maxEntryId=${input.id}&limit=1`,
					{ headers },
				)
				expect(selected.status).toBe(200)
				expect(agentEntriesPageSchema.parse(await selected.json()).items).toEqual(
					expected,
				)
			}
		}
		const history = await fetch(`${conversationUrl}/entries?limit=100&order=ascending`, {
			headers,
		})
		expect(history.status).toBe(200)
		const entries = agentEntriesPageSchema.parse(await history.json()).items
		const inputs = entries.filter((entry) => entry.kind === "slate.schedule")
		expect(inputs).toHaveLength(1)
		const input = inputs[0]
		assert(input)
		expect(input.data).toEqual({ schedule: "greeting", scheduleId: schedule.id })
		expect(input.model).toContainEqual(
			expect.objectContaining({ content: schedule.payload.prompt, role: "user" }),
		)
		const answer = entries.filter((entry) => entry.kind === AssistantEntry.kind).at(-1)
		assert(answer)
		expect(answer.conversationId).toBe(conversation.id)
		const message = z
			.looseObject({
				content: z.array(
					z.looseObject({ text: z.string().optional(), type: z.string() }),
				),
				role: z.literal("assistant"),
			})
			.parse(answer.model?.find((message) => message.role === "assistant"))
		expect(
			message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("").length,
		).toBeGreaterThan(0)
		completedConversations.push({ answer, conversation, input })
	}
	const listed = await fetch(conversationsUrl, { headers })
	expect(listed.status).toBe(200)
	expect(agentConversationsPageSchema.parse(await listed.json()).items).toEqual(
		expect.arrayContaining([first, second]),
	)
	const userAfter = await fetch(`${userUrl}/conversations?limit=100`, { headers })
	expect(userAfter.status).toBe(200)
	const userDirectory = agentConversationsPageSchema.parse(await userAfter.json())
	expect(userDirectory).toEqual({
		...userConversations,
		items: expect.arrayContaining([...userConversations.items, userConversation]),
	})
	expect(userDirectory.items).toHaveLength(userConversations.items.length + 1)
	const ids = await worker.listDurableObjectIds("SlateAgent")
	expect(ids.length).toBeGreaterThan(0)
	for (const id of ids) await worker.evictDurableObject("SlateAgent", { id })
	for (const { answer, conversation, input } of completedConversations) {
		const conversationUrl = `${url}/conversations/${conversation.id}`
		const retainedAnswer = await fetch(
			`${conversationUrl}/entries?minEntryId=${answer.id}&maxEntryId=${answer.id}&limit=1`,
			{ headers },
		)
		expect(retainedAnswer.status).toBe(200)
		expect(agentEntriesPageSchema.parse(await retainedAnswer.json()).items).toEqual([
			answer,
		])
		const retainedInput = await fetch(
			`${conversationUrl}/entries?minEntryId=${input.id}&maxEntryId=${input.id}&limit=1`,
			{ headers },
		)
		expect(retainedInput.status).toBe(200)
		expect(agentEntriesPageSchema.parse(await retainedInput.json()).items).toEqual([
			input,
		])
		const retained = await fetch(conversationUrl, { headers })
		expect(retained.status).toBe(200)
		const view = agentConversationViewSchema.parse(await retained.json())
		expect(view.conversation).toEqual(conversation)
		expect(view.docs[LiveDoc.definition.kind]?.run).toBeUndefined()
		expect(view.docs[LiveDoc.definition.kind]?.runFailure).toBeUndefined()
	}
}, 300_000)
