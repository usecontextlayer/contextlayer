import assert from "node:assert/strict"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import {
	AssistantEntry,
	InboxDoc,
	ToolResultEntry,
	UsageDoc,
	UserEntry,
} from "@earendil-works/pi-durable"
import { test } from "@tests/integration"
import { copySlateProject } from "@usecontextlayer/dev-env/slate"
import { signInViewer } from "@usecontextlayer/dev-env/viewer"
import { expect } from "vitest"
import { z } from "zod"
import {
	agentConversationSchema,
	agentConversationsPageSchema,
	agentConversationViewSchema,
	agentEntriesPageSchema,
	agentSubmissionSchema,
} from "@/agents.schema"
import { slateSchema } from "@/slates.schema"

test.for(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const)(
	"API conversations without an app using %s retain their results and history",
	{ timeout: 240_000 },
	async (providerSecret, { directory, git, platform, webEnv, webSession }) => {
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
		await copySlateProject(directory, { scaffold: "empty" })
		expect(await readdir(directory)).not.toContain("app")
		await mkdir(`${directory}/agents/brief`, { recursive: true })
		await writeFile(
			`${directory}/agents/brief/instructions.md`,
			"You are a concise assistant.\n",
		)
		await writeFile(
			`${directory}/agents/brief/slate.json`,
			JSON.stringify({
				connections: {},
				secrets: { [providerSecret]: { mode: "viewer" } },
			}),
		)
		await git("init", "-b", "main")
		await git("config", "user.name", "Pi API Acceptance")
		await git("config", "user.email", "pi-api-test@example.com")
		await git("add", ".")
		await git(
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-m",
			"Author Pi API acceptance agent",
		)
		await git("push", `${origin}/git/${slate.id}`, "main")
		const url = `${origin}/api/slates/${slate.id}/agents/brief`
		const completedConversations = []
		const markerPath = "/workspace/contextlayer-coding-tools.txt"
		const prompts = [
			`Use bash to run uname -s, then write CREATED to ${markerPath} and print the file contents. Report completion briefly.`,
		]
		if (providerSecret === "ANTHROPIC_API_KEY") {
			prompts.push(
				`Use bash to read ${markerPath} without creating or changing it. Report the file contents briefly.`,
			)
		}
		for (const [index, prompt] of prompts.entries()) {
			const created = await fetch(`${url}/conversations`, { headers, method: "POST" })
			expect(created.status).toBe(201)
			const conversation = agentConversationSchema.parse(await created.json())
			const conversationUrl = `${url}/conversations/${conversation.id}`
			expect(new URL(created.headers.get("location") ?? "", origin).href).toBe(
				conversationUrl,
			)
			const submitted = await fetch(`${conversationUrl}/submissions`, {
				body: JSON.stringify({ content: prompt }),
				headers,
				method: "POST",
			})
			expect(submitted.status).toBe(202)
			const submission = agentSubmissionSchema.parse(await submitted.json())
			expect(submission.type).toBe("input")
			expect(submission.conversationId).toBe(conversation.id)
			let result: z.infer<typeof agentSubmissionSchema> | undefined
			await expect
				.poll(
					async () => {
						const response = await fetch(`${url}/submissions/${submission.id}`, {
							headers,
						})
						expect(response.status).toBe(200)
						result = agentSubmissionSchema.parse(await response.json())
						return result.status === "done" || result.status === "unanswered"
					},
					{ interval: 1000, timeout: 120_000 },
				)
				.toBe(true)
			assert(result)
			expect(result.status, JSON.stringify(result)).toBe("done")
			assert(result.type === "input" && result.status === "done")
			expect(result.id).toBe(submission.id)
			expect(result.conversationId).toBe(conversation.id)
			const history = await fetch(
				`${conversationUrl}/entries?limit=100&order=ascending`,
				{
					headers,
				},
			)
			expect(history.status).toBe(200)
			const entries = agentEntriesPageSchema.parse(await history.json()).items
			const userEntries = entries.filter((entry) => entry.kind === UserEntry.kind)
			expect(userEntries).toHaveLength(1)
			expect(userEntries[0]?.model).toContainEqual(
				expect.objectContaining({ content: prompt, role: "user" }),
			)
			const toolResults = entries
				.filter((entry) => entry.kind === ToolResultEntry.kind)
				.flatMap((entry) => entry.model ?? [])
				.filter((message) => message.role === "toolResult")
			const executionResults = toolResults
				.filter(
					(message) =>
						(message.toolName === "bash" || message.toolName === "read") &&
						message.isError === false,
				)
				.map((message) =>
					z
						.looseObject({
							content: z.array(z.object({ text: z.string(), type: z.literal("text") })),
							toolName: z.enum(["bash", "read"]),
						})
						.parse(message),
				)
			const outputs = executionResults.map((message) => ({
				text: message.content.map((content) => content.text).join("\n"),
				toolName: message.toolName,
			}))
			if (index === 0) {
				expect(
					outputs
						.filter((output) => output.toolName === "bash")
						.map((output) => output.text)
						.join("\n"),
				).toContain("Linux")
			}
			expect(outputs.map((output) => output.text).join("\n")).toContain("CREATED")
			const answered = await fetch(
				`${conversationUrl}/entries?minEntryId=${result.answer}&maxEntryId=${result.answer}&limit=1`,
				{ headers },
			)
			expect(answered.status).toBe(200)
			const answers = agentEntriesPageSchema.parse(await answered.json()).items
			expect(answers).toHaveLength(1)
			const answer = answers[0]
			assert(answer)
			expect(answer.id).toBe(result.answer)
			expect(answer.kind).toBe(AssistantEntry.kind)
			expect(answer.conversationId).toBe(conversation.id)
			const assistant = z
				.looseObject({
					content: z.array(z.unknown()),
					model: z.string(),
					provider: z.string(),
					role: z.literal("assistant"),
				})
				.parse(answer.model?.find((message) => message.role === "assistant"))
			expect(assistant.model).toBe("claude-haiku-4-5")
			expect(assistant.content).toContainEqual(expect.objectContaining({ type: "text" }))
			const inspected = await fetch(conversationUrl, { headers })
			expect(inspected.status).toBe(200)
			const view = agentConversationViewSchema.parse(await inspected.json())
			expect(view.conversation).toEqual(conversation)
			const usage = z
				.object({ models: z.record(z.string(), z.object({ totalTokens: z.number() })) })
				.parse(view.docs[UsageDoc.definition.kind])
			expect(
				usage.models[`${assistant.provider}/${assistant.model}`]?.totalTokens,
			).toBeGreaterThan(0)
			expect(view.docs[InboxDoc.definition.kind]).toMatchObject({ items: [] })
			completedConversations.push({ answer, conversation, prompts: [prompt], result })
		}
		if (providerSecret === "CLAUDE_CODE_OAUTH_TOKEN") return
		const first = completedConversations[0]
		const second = completedConversations[1]
		assert(first && second)
		expect(first.conversation.id).not.toBe(second.conversation.id)
		const firstUrl = `${url}/conversations/${first.conversation.id}`
		const followup =
			"Summarize what you did in your previous response in one sentence. Do not use tools."
		const continued = await fetch(`${firstUrl}/submissions`, {
			body: JSON.stringify({ content: followup }),
			headers,
			method: "POST",
		})
		expect(continued.status).toBe(202)
		const continuation = agentSubmissionSchema.parse(await continued.json())
		expect(continuation.conversationId).toBe(first.conversation.id)
		expect(continuation.id).not.toBe(first.result.id)
		let continuedResult: z.infer<typeof agentSubmissionSchema> | undefined
		await expect
			.poll(
				async () => {
					const response = await fetch(`${url}/submissions/${continuation.id}`, {
						headers,
					})
					expect(response.status).toBe(200)
					continuedResult = agentSubmissionSchema.parse(await response.json())
					return (
						continuedResult.status === "done" || continuedResult.status === "unanswered"
					)
				},
				{ interval: 1000, timeout: 120_000 },
			)
			.toBe(true)
		assert(continuedResult)
		expect(continuedResult.status, JSON.stringify(continuedResult)).toBe("done")
		assert(continuedResult.type === "input" && continuedResult.status === "done")
		const continuedAnswer = continuedResult.answer
		expect(continuedAnswer).not.toBe(first.result.answer)
		first.prompts.push(followup)
		const pageQuery = new URLSearchParams({ limit: "2", order: "ascending" })
		const pagedEntries: z.infer<typeof agentEntriesPageSchema>["items"] = []
		let historyPage: z.infer<typeof agentEntriesPageSchema>
		do {
			const response = await fetch(`${firstUrl}/entries?${pageQuery}`, { headers })
			expect(response.status).toBe(200)
			historyPage = agentEntriesPageSchema.parse(await response.json())
			expect(historyPage.items.length).toBeLessThanOrEqual(2)
			pagedEntries.push(...historyPage.items)
			if (historyPage.next) pageQuery.set("cursor", JSON.stringify(historyPage.next))
		} while (historyPage.next)
		expect(
			pagedEntries
				.filter((entry) => entry.kind === UserEntry.kind)
				.flatMap((entry) =>
					(entry.model ?? [])
						.filter((message) => message.role === "user")
						.map((message) => message.content),
				),
		).toEqual(first.prompts)
		expect(new Set(pagedEntries.map((entry) => entry.id)).size).toBe(pagedEntries.length)
		expect(pagedEntries).toContainEqual(first.answer)
		expect(pagedEntries.some((entry) => entry.id === continuedAnswer)).toBe(true)
		const conversationsQuery = new URLSearchParams({ limit: "1", order: "ascending" })
		const conversations: z.infer<typeof agentConversationsPageSchema>["items"] = []
		let conversationPage: z.infer<typeof agentConversationsPageSchema>
		do {
			const response = await fetch(`${url}/conversations?${conversationsQuery}`, {
				headers,
			})
			expect(response.status).toBe(200)
			conversationPage = agentConversationsPageSchema.parse(await response.json())
			expect(conversationPage.items.length).toBeLessThanOrEqual(1)
			conversations.push(...conversationPage.items)
			if (conversationPage.next)
				conversationsQuery.set("cursor", JSON.stringify(conversationPage.next))
		} while (conversationPage.next)
		expect(conversations).toEqual(
			expect.arrayContaining([first.conversation, second.conversation]),
		)
		expect(new Set(conversations.map((conversation) => conversation.id)).size).toBe(
			conversations.length,
		)
		const ids = await worker.listDurableObjectIds("SlateAgent")
		expect(ids.length).toBeGreaterThan(0)
		for (const id of ids) await worker.evictDurableObject("SlateAgent", { id })
		for (const { answer, conversation, prompts, result } of completedConversations) {
			const retained = await fetch(`${url}/submissions/${result.id}`, { headers })
			expect(retained.status).toBe(200)
			expect(agentSubmissionSchema.parse(await retained.json())).toEqual(result)
			const answered = await fetch(
				`${url}/conversations/${conversation.id}/entries?minEntryId=${result.answer}&maxEntryId=${result.answer}&limit=1`,
				{ headers },
			)
			expect(answered.status).toBe(200)
			expect(agentEntriesPageSchema.parse(await answered.json()).items).toEqual([answer])
			const history = await fetch(
				`${url}/conversations/${conversation.id}/entries?limit=100&order=ascending`,
				{ headers },
			)
			expect(history.status).toBe(200)
			const entries = agentEntriesPageSchema.parse(await history.json()).items
			expect(
				entries
					.filter((entry) => entry.kind === UserEntry.kind)
					.flatMap((entry) =>
						(entry.model ?? [])
							.filter((message) => message.role === "user")
							.map((message) => message.content),
					),
			).toEqual(prompts)
		}
		const viewerHeaders = await signInViewer({
			authURL: webEnv.CTX_VIEWER_AUTH_URL,
			returnTo: `https://${slate.public_hostname}/`,
			webHeaders: webSession.headers,
		})
		const inspectionPaths = ["", "/entries?limit=10"]
		for (const path of inspectionPaths) {
			const denied = await fetch(`${firstUrl}${path}`, { headers: viewerHeaders })
			expect(denied.status).toBe(401)
		}
		const publicSlate = await fetch(`${origin}/api/slates/${slate.id}`, {
			body: JSON.stringify({ visibility: "public" }),
			headers,
			method: "PATCH",
		})
		expect(publicSlate.status).toBe(200)
		for (const path of inspectionPaths) {
			const denied = await fetch(`${firstUrl}${path}`, { headers })
			expect(denied.status).toBe(403)
		}
		const privateSlate = await fetch(`${origin}/api/slates/${slate.id}`, {
			body: JSON.stringify({ visibility: "private" }),
			headers,
			method: "PATCH",
		})
		expect(privateSlate.status).toBe(200)
	},
)
