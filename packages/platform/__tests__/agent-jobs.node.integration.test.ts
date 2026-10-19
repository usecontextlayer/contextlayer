import { execFile as execFileCallback } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { AssistantEntry, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable"
import { test } from "@tests/integration"
import { signInViewer } from "@usecontextlayer/dev-env/viewer"
import { getAgentByName } from "agents/routing"
import { expect } from "vitest"
import { z } from "zod"
import { getAgentInstanceName } from "@/agent-instance"
import {
	agentJobCreationSchema,
	agentJobEntrySchema,
	agentJobInspectionSchema,
	agentJobMessageSchema,
	agentJobOperationSchema,
	agentJobResultSchema,
	agentJobSessionSchema,
	agentJobUsageSchema,
	agentRunSchema,
} from "@/agents.schema"
import { startAgentRun } from "@/agents.server"
import { slateSchema } from "@/slates.schema"

const execFile = promisify(execFileCallback)

test("failed job admission leaves the catalog empty", async ({ platform }) => {
	const run = agentRunSchema.parse({
		actor: { type: "app" },
		agent: {
			commit: "admission-fixture",
			instructions: "Answer briefly.",
			name: "missing-model",
		},
		connections: {},
		databases: {},
		prompt: "Say hello.",
		secrets: {
			ANTHROPIC_MODEL: { id: crypto.randomUUID(), type: "personal" },
		},
		slateId: crypto.randomUUID(),
	})
	const { AGENTS } = await platform.worker.getEnv()
	await expect(startAgentRun(AGENTS, run)).rejects.toThrow()
	const agent = await getAgentByName(
		AGENTS,
		getAgentInstanceName(run.slateId, run.agent.name, run.actor),
	)
	expect(await agent.listJobs()).toEqual([])
})

test.for(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const)(
	"API jobs using %s expose native Bash execution",
	{ timeout: 240_000 },
	async (providerSecret, { directory, platform, webEnv, webSession }) => {
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
			const { ARTIFACTS } = await worker.getEnv()
			await ARTIFACTS.delete(slate.id)
		})
		const repo = await ARTIFACTS.get(slate.id)
		const { remote } = await repo.info()
		const token = await repo.createToken("write")
		await mkdir(`${directory}/agents/brief`, { recursive: true })
		await mkdir(`${directory}/public`)
		await writeFile(`${directory}/public/slate.json`, JSON.stringify({ connections: {} }))
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
		const gitEnv = {
			...process.env,
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_GLOBAL: `${directory}/gitconfig`,
			GIT_CONFIG_KEY_0: "http.extraHeader",
			GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token.plaintext}`,
			GIT_TERMINAL_PROMPT: "0",
		}
		const git = (...args: string[]) =>
			execFile("git", args, { cwd: directory, env: gitEnv })
		await git("init", "-b", "main")
		await git("config", "user.name", "Pi API Acceptance")
		await git("config", "user.email", "pi-api-test@example.com")
		await git("add", "agents", "public")
		await git(
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-m",
			"Author Pi API acceptance agent",
		)
		await git("push", remote, "main")
		const url = `${origin}/api/slates/${slate.id}/agents/brief/jobs`
		const creations = []
		const results: z.infer<typeof agentJobResultSchema>[] = []
		const markerPath = "/workspace/contextlayer-coding-tools.txt"
		const prompts = [
			`Use bash to run uname -s, then write CREATED to ${markerPath} and print the file contents. Report completion briefly.`,
		]
		if (providerSecret === "ANTHROPIC_API_KEY") {
			prompts.push(
				`Use bash to check whether ${markerPath} exists before creating or changing any files. If it is absent, print FRESH_JOB_FILESYSTEM; if it exists, exit with code 1. Report completion briefly.`,
			)
		}
		for (const [index, prompt] of prompts.entries()) {
			const submitted = await fetch(url, {
				body: JSON.stringify({ prompt }),
				headers,
				method: "POST",
			})
			expect(submitted.status).toBe(202)
			const creation = agentJobCreationSchema.strict().parse(await submitted.json())
			const { job, receipt } = creation
			const jobUrl = `${url}/${job.id}`
			expect(new URL(submitted.headers.get("location") ?? "", origin).href).toBe(jobUrl)
			expect(receipt.accepted).toBe(true)
			expect(receipt.operationId).not.toBe(job.id)
			expect(job.metadata).toEqual({
				actor: { id: slate.owner_user_id, type: "user" },
				trigger: { type: "api" },
			})
			creations.push(creation)
			const detail = await fetch(jobUrl, { headers })
			expect(detail.status).toBe(200)
			expect(agentJobEntrySchema.strict().parse(await detail.json())).toEqual(job)
			const operation = await fetch(`${jobUrl}/operation`, { headers })
			expect(operation.status).toBe(200)
			expect(agentJobOperationSchema.parse(await operation.json())).toMatchObject({
				operationId: receipt.operationId,
				session: receipt.session,
			})
			const liveInspectionResponse = await fetch(`${jobUrl}/inspection`, { headers })
			expect(liveInspectionResponse.status).toBe(200)
			console.info(
				"Native live Pi inspection",
				agentJobInspectionSchema.parse(await liveInspectionResponse.json()),
			)
			const completed = await fetch(`${jobUrl}/result`, { headers })
			expect(completed.status).toBe(200)
			const result = agentJobResultSchema.strict().parse(await completed.json())
			console.info("Real Pi API result", result)
			expect(result.operationId).toBe(receipt.operationId)
			expect(result.session).toBe(receipt.session)
			results.push(result)
			const settledOperation = await fetch(`${jobUrl}/operation`, { headers })
			expect(settledOperation.status).toBe(200)
			expect(agentJobResultSchema.strict().parse(await settledOperation.json())).toEqual(
				result,
			)
			const sessionResponse = await fetch(`${jobUrl}/sessions`, { headers })
			expect(sessionResponse.status).toBe(200)
			const sessions = z.array(agentJobSessionSchema).parse(await sessionResponse.json())
			expect(sessions.map((session) => session.id)).toEqual([receipt.session])
			const messageResponse = await fetch(
				`${jobUrl}/sessions/${receipt.session}/messages`,
				{ headers },
			)
			expect(messageResponse.status).toBe(200)
			const messages = z.array(agentJobMessageSchema).parse(await messageResponse.json())
			expect(
				result.status,
				JSON.stringify({
					assistant: messages.filter((entry) => entry.kind === AssistantEntry.kind),
					reason: result.reason,
				}),
			).toBe("done")

			const userEntries = messages.filter((entry) => entry.kind === UserEntry.kind)
			expect(userEntries).toHaveLength(1)
			expect(userEntries[0]?.model).toContainEqual(
				expect.objectContaining({ content: prompt, role: "user" }),
			)
			const toolResults = messages
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
			const bashOutput = outputs
				.filter((output) => output.toolName === "bash")
				.map((output) => output.text)
				.join("\n")
			if (index === 0) {
				expect(bashOutput).toContain("Linux")
				expect(outputs.map((output) => output.text).join("\n")).toContain("CREATED")
			} else {
				expect(bashOutput).toContain("FRESH_JOB_FILESYSTEM")
			}
			console.info("Native Pi execution results", executionResults)
			const assistantEntry = messages
				.filter((entry) => entry.kind === AssistantEntry.kind)
				.at(-1)
			expect(assistantEntry?.conversationId).toBe(userEntries[0]?.conversationId)
			const assistant = z
				.looseObject({
					content: z.array(z.unknown()),
					model: z.string(),
					provider: z.string(),
					role: z.literal("assistant"),
				})
				.parse(assistantEntry?.model?.find((message) => message.role === "assistant"))
			expect(assistant.content).toContainEqual(expect.objectContaining({ type: "text" }))
			const usageResponse = await fetch(`${jobUrl}/usage`, { headers })
			expect(usageResponse.status).toBe(200)
			const usage = agentJobUsageSchema.parse(await usageResponse.json())
			expect(
				usage.models[`${assistant.provider}/${assistant.model}`]?.totalTokens,
			).toBeGreaterThan(0)
			const inspectionResponse = await fetch(`${jobUrl}/inspection`, { headers })
			expect(inspectionResponse.status).toBe(200)
			const inspection = agentJobInspectionSchema.parse(await inspectionResponse.json())
			expect(inspection.submissions).toEqual([])
			console.info("Native Pi inspection", { inspection, sessions, usage })
		}
		if (providerSecret === "CLAUDE_CODE_OAUTH_TOKEN") {
			const deleted = await fetch(`${url}/${creations[0]?.job.id}`, {
				headers,
				method: "DELETE",
			})
			expect(deleted.status).toBe(204)
			return
		}
		expect(creations[0]?.job.id).not.toBe(creations[1]?.job.id)
		await platform.harness.update((current) => current)
		for (const [index, { job, receipt }] of creations.entries()) {
			const operation = await fetch(`${url}/${job.id}/operation`, { headers })
			expect(operation.status).toBe(200)
			expect(agentJobResultSchema.strict().parse(await operation.json())).toEqual(
				results[index],
			)
			const response = await fetch(
				`${url}/${job.id}/sessions/${receipt.session}/messages`,
				{
					headers,
				},
			)
			expect(response.status).toBe(200)
			const messages = z.array(agentJobMessageSchema).parse(await response.json())
			expect(messages.filter((entry) => entry.kind === UserEntry.kind)).toHaveLength(1)
		}
		const catalogSchema = z
			.object({ jobs: z.array(agentJobEntrySchema.strict()) })
			.strict()
		const listed = await fetch(url, { headers })
		expect(listed.status).toBe(200)
		const catalog = catalogSchema.parse(await listed.json())
		expect(catalog.jobs).toEqual([...creations].reverse().map(({ job }) => job))
		console.info("Native job catalog", catalog)
		const scheduled = await fetch(`${url}?schedule=greeting`, { headers })
		expect(scheduled.status).toBe(200)
		expect(catalogSchema.parse(await scheduled.json()).jobs).toEqual([])
		const continued = await fetch(url, {
			body: JSON.stringify({ conversation_id: "1", prompt: "Continue" }),
			headers,
			method: "POST",
		})
		expect(continued.status).toBe(400)
		for (const result of results) {
			expect(result.text?.length).toBeGreaterThan(0)
		}
		const submitted = await fetch(url, {
			body: JSON.stringify({ prompt: "Write a short greeting." }),
			headers,
			method: "POST",
		})
		expect(submitted.status).toBe(202)
		const abortedCreation = agentJobCreationSchema.strict().parse(await submitted.json())
		const abortedUrl = `${url}/${abortedCreation.job.id}`
		const aborted = await fetch(`${abortedUrl}/operation`, { headers, method: "DELETE" })
		expect(aborted.status).toBe(200)
		const wasAborted = z.boolean().parse(await aborted.json())
		const settled = await fetch(`${abortedUrl}/result`, { headers })
		expect(settled.status).toBe(200)
		const abortedResult = agentJobResultSchema.strict().parse(await settled.json())
		expect(abortedResult.operationId).toBe(abortedCreation.receipt.operationId)
		expect(abortedResult.operationId).not.toBe(abortedCreation.job.id)
		console.info("Native Pi abort", { aborted: wasAborted, result: abortedResult })
		const retained = await fetch(abortedUrl, { headers })
		expect(retained.status).toBe(200)
		expect(agentJobEntrySchema.strict().parse(await retained.json())).toEqual(
			abortedCreation.job,
		)
		const alreadySettled = await fetch(`${abortedUrl}/operation`, {
			headers,
			method: "DELETE",
		})
		expect(alreadySettled.status).toBe(200)
		expect(await alreadySettled.json()).toBe(false)
		creations.push(abortedCreation)
		const viewerHeaders = await signInViewer({
			authURL: webEnv.CTX_VIEWER_AUTH_URL,
			returnTo: `https://${slate.public_hostname}/`,
			webHeaders: webSession.headers,
		})
		const inspectionPaths = [
			"/sessions",
			`/sessions/${abortedCreation.receipt.session}/messages`,
			"/usage",
			"/inspection",
		]
		for (const path of inspectionPaths) {
			const denied = await fetch(`${abortedUrl}${path}`, { headers: viewerHeaders })
			expect(denied.status).toBe(401)
		}
		const publicSlate = await fetch(`${origin}/api/slates/${slate.id}`, {
			body: JSON.stringify({ visibility: "public" }),
			headers,
			method: "PATCH",
		})
		expect(publicSlate.status).toBe(200)
		for (const path of inspectionPaths) {
			const denied = await fetch(`${abortedUrl}${path}`, { headers })
			expect(denied.status).toBe(403)
		}
		const privateSlate = await fetch(`${origin}/api/slates/${slate.id}`, {
			body: JSON.stringify({ visibility: "private" }),
			headers,
			method: "PATCH",
		})
		expect(privateSlate.status).toBe(200)
		for (const { job } of creations) {
			const deleted = await fetch(`${url}/${job.id}`, { headers, method: "DELETE" })
			expect(deleted.status).toBe(204)
			for (const suffix of ["", "/operation", "/result"]) {
				const missing = await fetch(`${url}/${job.id}${suffix}`, { headers })
				expect(missing.status).toBe(404)
			}
		}
		const empty = await fetch(url, { headers })
		expect(empty.status).toBe(200)
		expect(catalogSchema.parse(await empty.json()).jobs).toEqual([])
	},
)
