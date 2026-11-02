import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { AssistantEntry, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable"
import { test } from "@tests/integration"
import { copySlateProject } from "@usecontextlayer/dev-env/slate"
import { signInViewer } from "@usecontextlayer/dev-env/viewer"
import { expect } from "vitest"
import { z } from "zod"
import {
	agentJobCreationSchema,
	agentJobEntrySchema,
	agentJobInspectionSchema,
	agentJobMessageSchema,
	agentJobResultSchema,
	agentJobSessionSchema,
	agentJobUsageSchema,
} from "@/agents.schema"
import { slateSchema } from "@/slates.schema"

const execFile = promisify(execFileCallback)

test.for(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const)(
	"API jobs using %s complete through the declared provider",
	{ timeout: 240_000 },
	async (providerSecret, { cliEnv, directory, platform, webEnv, webSession }) => {
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
		await copySlateProject(directory)
		await mkdir(`${directory}/agents/brief`, { recursive: true })
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
		const cli = join(import.meta.dirname, "../../cli/dist/cli.mjs")
		const gitEnv = {
			...process.env,
			...cliEnv,
			GIT_CONFIG_GLOBAL: join(directory, "gitconfig"),
			GIT_TERMINAL_PROMPT: "0",
		}
		const git = (...args: string[]) =>
			execFile("git", args, { cwd: directory, env: gitEnv })
		await git(
			"config",
			"--global",
			`credential.${origin}/git.helper`,
			`${cli} git-credential`,
		)
		await git("init", "-b", "main")
		await git("config", "user.name", "Pi API Acceptance")
		await git("config", "user.email", "pi-api-test@example.com")
		await git("add", ".", ":!gitconfig")
		await git(
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-m",
			"Author Pi API acceptance agent",
		)
		await git("push", `${origin}/git/${slate.id}`, "main")
		const url = `${origin}/api/slates/${slate.id}/agents/brief/jobs`
		const completedJobs = []
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
			const completed = await fetch(`${jobUrl}/result`, { headers })
			expect(completed.status).toBe(200)
			const result = agentJobResultSchema.strict().parse(await completed.json())
			expect(result.status, result.reason).toBe("done")
			expect(result.operationId).toBe(receipt.operationId)
			expect(result.session).toBe(receipt.session)
			completedJobs.push({ ...creation, result })
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
			expect(assistant.model).toBe("claude-haiku-4-5")
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
		}
		const completedJob = completedJobs[0]
		assert(completedJob)
		if (providerSecret === "CLAUDE_CODE_OAUTH_TOKEN") {
			const deleted = await fetch(`${url}/${completedJob.job.id}`, {
				headers,
				method: "DELETE",
			})
			expect(deleted.status).toBe(204)
			return
		}
		expect(completedJob.job.id).not.toBe(completedJobs[1]?.job.id)
		const inspector = platform.harness.getWorker("contextlayer-platform-test")
		for (const binding of ["AGENT_JOBS", "AGENTS"] as const) {
			const ids = await inspector.listDurableObjectIds(binding)
			expect(ids.length).toBeGreaterThan(0)
			for (const id of ids) await inspector.evictDurableObject(binding, { id })
		}
		for (const { job, receipt, result } of completedJobs) {
			const operation = await fetch(`${url}/${job.id}/operation`, { headers })
			expect(operation.status).toBe(200)
			expect(agentJobResultSchema.strict().parse(await operation.json())).toEqual(result)
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
		expect(catalog.jobs).toEqual([...completedJobs].reverse().map(({ job }) => job))
		const scheduled = await fetch(`${url}?schedule=greeting`, { headers })
		expect(scheduled.status).toBe(200)
		expect(catalogSchema.parse(await scheduled.json()).jobs).toEqual([])
		const continued = await fetch(url, {
			body: JSON.stringify({ conversation_id: "1", prompt: "Continue" }),
			headers,
			method: "POST",
		})
		expect(continued.status).toBe(400)
		for (const { result } of completedJobs) {
			expect(result.text?.length).toBeGreaterThan(0)
		}
		const completedUrl = `${url}/${completedJob.job.id}`
		const alreadySettled = await fetch(`${completedUrl}/operation`, {
			headers,
			method: "DELETE",
		})
		expect(alreadySettled.status).toBe(200)
		expect(await alreadySettled.json()).toBe(false)
		const retained = await fetch(completedUrl, { headers })
		expect(retained.status).toBe(200)
		expect(agentJobEntrySchema.strict().parse(await retained.json())).toEqual(
			completedJob.job,
		)
		const viewerHeaders = await signInViewer({
			authURL: webEnv.CTX_VIEWER_AUTH_URL,
			returnTo: `https://${slate.public_hostname}/`,
			webHeaders: webSession.headers,
		})
		const inspectionPaths = [
			"/sessions",
			`/sessions/${completedJob.receipt.session}/messages`,
			"/usage",
			"/inspection",
		]
		for (const path of inspectionPaths) {
			const denied = await fetch(`${completedUrl}${path}`, { headers: viewerHeaders })
			expect(denied.status).toBe(401)
		}
		const publicSlate = await fetch(`${origin}/api/slates/${slate.id}`, {
			body: JSON.stringify({ visibility: "public" }),
			headers,
			method: "PATCH",
		})
		expect(publicSlate.status).toBe(200)
		for (const path of inspectionPaths) {
			const denied = await fetch(`${completedUrl}${path}`, { headers })
			expect(denied.status).toBe(403)
		}
		const privateSlate = await fetch(`${origin}/api/slates/${slate.id}`, {
			body: JSON.stringify({ visibility: "private" }),
			headers,
			method: "PATCH",
		})
		expect(privateSlate.status).toBe(200)
		for (const { job } of completedJobs) {
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
