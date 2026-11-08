import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AssistantEntry, UsageDoc } from "@earendil-works/pi-durable"
import { test } from "@tests/integration"
import { copySlateProject } from "@usecontextlayer/dev-env/slate"
import { slateResourcesSchema } from "@usecontextlayer/shared/slate-resources"
import { expect } from "vitest"
import {
	agentConversationSchema,
	agentConversationViewSchema,
	agentEntriesPageSchema,
	agentSubmissionSchema,
} from "@/agents.schema"
import { loadSharedSecret } from "@/secrets.server"
import { slateSchema } from "@/slates.schema"

test("API conversations honor a declared non-default Owner model", async ({
	git,
	directory,
	organization,
	platform,
	webSession,
}) => {
	const { origin, worker } = platform
	const headers = new Headers(webSession.headers)
	headers.set("origin", origin)
	headers.set("content-type", "application/json")
	const owner = { id: organization.id, type: "organization" } as const
	const expectedModel = await loadSharedSecret(platform.env, owner, "ANTHROPIC_MODEL")
	expect(expectedModel, "Configure an Owner model different from the default").not.toBe(
		"claude-haiku-4-5",
	)
	const created = await fetch(`${origin}/api/slates`, {
		body: JSON.stringify({ organization_slug: organization.slug }),
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
	await copySlateProject(directory)
	await mkdir(join(directory, "agents/model"), { recursive: true })
	await writeFile(join(directory, "app/slate.json"), JSON.stringify({ connections: {} }))
	await writeFile(
		join(directory, "agents/model/slate.json"),
		JSON.stringify({
			connections: {},
			secrets: {
				ANTHROPIC_API_KEY: { mode: "owner" },
				ANTHROPIC_MODEL: { mode: "owner" },
			},
		}),
	)
	await writeFile(
		join(directory, "agents/model/instructions.md"),
		"Answer briefly without using tools.\n",
	)
	await git("init", "-b", "main")
	await git("config", "user.name", "Pi Model Acceptance")
	await git("config", "user.email", "pi-model-test@example.com")
	await git("add", ".")
	await git("-c", "commit.gpgsign=false", "commit", "-m", "Declare agent model")
	await git("push", `${origin}/git/${slate.id}`, "main")
	const inventory = await fetch(`${origin}/api/slates/${slate.id}/resources/list`, {
		body: "{}",
		headers,
		method: "POST",
	})
	expect(inventory.status).toBe(200)
	const configured = slateResourcesSchema.parse(await inventory.json()).resources
	expect(configured.secrets.ANTHROPIC_API_KEY?.owner).toEqual(owner)
	expect(configured.secrets.ANTHROPIC_MODEL?.owner).toEqual(owner)
	const url = `${origin}/api/slates/${slate.id}/agents/model`
	const conversationResponse = await fetch(`${url}/conversations`, {
		headers,
		method: "POST",
	})
	expect(conversationResponse.status).toBe(201)
	const conversation = agentConversationSchema.parse(await conversationResponse.json())
	const conversationUrl = `${url}/conversations/${conversation.id}`
	const submitted = await fetch(`${conversationUrl}/submissions`, {
		body: JSON.stringify({ content: "Say hello in one sentence." }),
		headers,
		method: "POST",
	})
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
			{ interval: 1000, timeout: 180_000 },
		)
		.toBe(true)
	expect(result.status, result.status === "unanswered" ? result.reason : undefined).toBe(
		"done",
	)
	assert(result.type === "input" && result.status === "done")
	const response = await fetch(
		`${conversationUrl}/entries?minEntryId=${result.answer}&maxEntryId=${result.answer}&limit=1`,
		{ headers },
	)
	expect(response.status).toBe(200)
	const { items } = agentEntriesPageSchema.parse(await response.json())
	expect(items).toHaveLength(1)
	expect(items[0]).toMatchObject({ id: result.answer, kind: AssistantEntry.kind })
	const assistants = items
		.flatMap((entry) => entry.model ?? [])
		.filter((message) => message.role === "assistant")
	expect(assistants.length).toBeGreaterThan(0)
	for (const assistant of assistants)
		expect(assistant).toMatchObject({ model: expectedModel, provider: "anthropic" })
	const viewResponse = await fetch(conversationUrl, { headers })
	expect(viewResponse.status).toBe(200)
	const view = agentConversationViewSchema.parse(await viewResponse.json())
	const usage = view.docs[UsageDoc.definition.kind]
	assert(usage)
	expect(usage.models).toEqual({ [`anthropic/${expectedModel}`]: expect.any(Object) })
}, 300_000)
