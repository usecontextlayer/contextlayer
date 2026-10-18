import { execFile as execFileCallback } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { AssistantEntry, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable"
import { test } from "@tests/integration"
import { signInViewer } from "@usecontextlayer/dev-env/viewer"
import { connectionsSchema } from "@usecontextlayer/shared/connections"
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
	"API jobs using %s expose native execution and isolated Linux computers",
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
			"You are a concise assistant. Prefix answers with PI_API_STORY1.\n",
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
		const marker = `PI_API_FILE_${slate.id}`
		const directMarker = `${marker}_DIRECT`
		const codemodeMarker = `${marker}_CODEMODE`
		const createCommand = `uname -s && node -e "require('node:fs').writeFileSync('${markerPath}', '${marker}'); console.log('CREATED')"`
		const prompts = [
			`First call bash directly with this exact shell command: ${JSON.stringify(createCommand)}. Its tool result must contain Linux and CREATED. Wait for that tool result. Then call the native write tool directly to overwrite ${markerPath} with ${marker}_DRAFT, edit directly to replace that complete text with ${directMarker}, and read directly to confirm the edited contents. Do not use Bash to substitute for these file tools. Then use one codemode call to sequentially read ${markerPath} with tools.read, save its returned string as read, write read + '_DRAFT' back with tools.write, and use tools.edit to replace ${directMarker}_DRAFT with ${codemodeMarker}. Finally await tools.bash with the exact command cat ${markerPath}. Check the returned structured result's exitCode and truncated fields, then uppercase its output in JavaScript, not in Bash. Emit exactly one text item by calling text(JSON.stringify(oneObject)) exactly once. Do not call console.log or any other text(), and do not return a value. The oneObject must contain read (the actual tools.read result), exitCode, truncated, and processed (the uppercased trimmed Bash output). Then report completion briefly.`,
			`Use bash directly to check whether ${markerPath} exists before creating or changing any files. If it is absent, print FRESH_JOB_FILESYSTEM; if it exists, print UNEXPECTED_SHARED_FILE and exit with code 1. Then report completion briefly.`,
		]
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
			const bashResults = toolResults
				.filter((message) => message.toolName === "bash")
				.map((message) =>
					z
						.looseObject({
							content: z.array(z.object({ text: z.string(), type: z.literal("text") })),
							isError: z.literal(false),
						})
						.parse(message),
				)
			const outputs = bashResults.map((message) =>
				message.content.map((content) => content.text).join("\n"),
			)
			if (index === 0) {
				expect(outputs.join("\n")).toContain("Linux")
				expect(outputs.join("\n")).toContain("CREATED")
				for (const toolName of ["read", "write", "edit"]) {
					expect(toolResults).toContainEqual(
						expect.objectContaining({ isError: false, toolName }),
					)
				}
				const readResult = z
					.looseObject({
						content: z.array(z.object({ text: z.string(), type: z.literal("text") })),
						isError: z.literal(false),
					})
					.parse(toolResults.find((message) => message.toolName === "read"))
				expect(readResult.content.map(({ text }) => text).join("\n")).toBe(directMarker)
				const codemodeResult = z
					.looseObject({
						content: z.array(z.object({ text: z.string(), type: z.literal("text") })),
						details: z.looseObject({
							calls: z.array(z.looseObject({ name: z.string(), status: z.string() })),
						}),
						isError: z.literal(false),
					})
					.parse(toolResults.filter((message) => message.toolName === "codemode").at(-1))
				for (const name of ["read", "write", "edit", "bash"]) {
					expect(codemodeResult.details.calls).toContainEqual(
						expect.objectContaining({ name, status: "ok" }),
					)
				}
				const evidence = z
					.object({
						exitCode: z.literal(0),
						processed: z.string(),
						read: z.string(),
						truncated: z.literal(false),
					})
					.parse(JSON.parse(z.string().parse(codemodeResult.content.at(-1)?.text)))
				expect(evidence.read).toBe(directMarker)
				expect(evidence.processed).toBe(codemodeMarker.toUpperCase())
				console.info("Native Pi Code Mode evidence", {
					details: codemodeResult.details,
					evidence,
				})
			} else {
				expect(outputs.join("\n")).toContain("FRESH_JOB_FILESYSTEM")
				expect(outputs.join("\n")).not.toContain("UNEXPECTED_SHARED_FILE")
			}
			console.info("Native Pi Bash results", bashResults)
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

test("API Code Mode binds two Gmail namespaces to their assigned accounts", async ({
	directory,
	platform,
	webSession,
}) => {
	const { origin, worker } = platform
	const headers = new Headers(webSession.headers)
	headers.set("origin", origin)
	headers.set("content-type", "application/json")
	const accountsResponse = await fetch(`${origin}/api/connections?toolkit=gmail`, {
		headers,
	})
	expect(accountsResponse.status).toBe(200)
	const { connections } = connectionsSchema.parse(await accountsResponse.json())
	const first = connections[0]
	const second = connections.find(
		(account) => account.display_name !== first?.display_name,
	)
	if (!first || !second)
		throw new Error("Connect two distinct Gmail accounts to the local development user")
	const assignments = { personal_email: second, work_email: first }
	for (const account of Object.values(assignments)) z.email().parse(account.display_name)
	const created = await fetch(`${origin}/api/slates`, {
		body: JSON.stringify({}),
		headers,
		method: "POST",
	})
	expect(created.status).toBe(201)
	const slate = slateSchema.parse(await created.json())
	await using resources = new AsyncDisposableStack()
	resources.defer(async () => {
		const { ARTIFACTS } = await worker.getEnv()
		await ARTIFACTS.delete(slate.id)
	})
	const { ARTIFACTS } = await worker.getEnv()
	const repo = await ARTIFACTS.get(slate.id)
	const { remote } = await repo.info()
	const token = await repo.createToken("write")
	await mkdir(`${directory}/agents/profiles`, { recursive: true })
	await mkdir(`${directory}/public`)
	await writeFile(`${directory}/public/slate.json`, JSON.stringify({ connections: {} }))
	await writeFile(
		`${directory}/agents/profiles/slate.json`,
		JSON.stringify({
			connections: {
				personal_email: { mode: "viewer", toolkit: "gmail" },
				work_email: { mode: "viewer", toolkit: "gmail" },
			},
			secrets: { ANTHROPIC_API_KEY: { mode: "viewer" } },
		}),
	)
	await writeFile(
		`${directory}/agents/profiles/instructions.md`,
		"Use only GMAIL_GET_PROFILE to read mailbox profile metadata. Never read messages or modify account data. Do not include email addresses in your final answer.\n",
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
	await git("config", "user.name", "Pi Composio Acceptance")
	await git("config", "user.email", "pi-composio-test@example.com")
	await git("add", "agents", "public")
	await git("-c", "commit.gpgsign=false", "commit", "-m", "Author Gmail profile agent")
	await git("push", remote, "main")
	for (const [slug, account] of Object.entries(assignments)) {
		const assigned = await fetch(`${origin}/api/slates/${slate.id}/connections/assign`, {
			body: JSON.stringify({ connection_id: account.id, slug }),
			headers,
			method: "POST",
		})
		expect(assigned.status).toBe(200)
	}
	const prompt =
		"Use two successive codemode calls. In the first call, discover the Gmail profile action separately with searchTools('Gmail profile', {namespace:'work_email'}) and searchTools('Gmail profile', {namespace:'personal_email'}), then use describeTool to obtain only the full GMAIL_GET_PROFILE declaration discovered in each namespace (not declarations for other search results). Emit one JSON object with discovered (each namespace's search results' tool names) and declarations (each namespace's full returned declaration string), both keyed by connection slug: work_email and personal_email. End this call and read the declarations before writing the second script. In the second call, execute tools.work_email__GMAIL_GET_PROFILE({user_id:'me'}) and tools.personal_email__GMAIL_GET_PROFILE({user_id:'me'}). Use the declared result shape to inspect data and error, extract the returned emailAddress and uppercase it in JavaScript. Emit one JSON object with profiles (each namespace maps to {emailUppercase,logId} from its actual response). Do not print full provider responses. In each call emit exactly once with text(JSON.stringify(oneObject)); do not call console.log or any other text(), and do not return a value. Then report completion without account details."
	const submitted = await fetch(`${origin}/api/slates/${slate.id}/agents/profiles/jobs`, {
		body: JSON.stringify({ prompt }),
		headers,
		method: "POST",
	})
	expect(submitted.status).toBe(202)
	const { job, receipt } = agentJobCreationSchema.parse(await submitted.json())
	const jobUrl = `${origin}/api/slates/${slate.id}/agents/profiles/jobs/${job.id}`
	resources.defer(async () => {
		const deleted = await fetch(jobUrl, { headers, method: "DELETE" })
		expect(deleted.status).toBe(204)
	})
	const completed = await fetch(`${jobUrl}/result`, { headers })
	expect(completed.status).toBe(200)
	const result = agentJobResultSchema.parse(await completed.json())
	expect(result.status, result.reason).toBe("done")
	expect(result.operationId).toBe(receipt.operationId)
	const response = await fetch(`${jobUrl}/sessions/${receipt.session}/messages`, {
		headers,
	})
	expect(response.status).toBe(200)
	const messages = z.array(agentJobMessageSchema).parse(await response.json())

	const codemodeSchema = z.looseObject({
		content: z.tuple([
			z.object({ text: z.string(), type: z.literal("text") }),
			z.object({ text: z.string(), type: z.literal("text") }),
		]),
		details: z.looseObject({
			calls: z.array(z.looseObject({ name: z.string(), status: z.string() })),
		}),
		isError: z.literal(false),
	})
	const codemodeMessages = messages
		.filter((entry) => entry.kind === ToolResultEntry.kind)
		.flatMap((entry) => entry.model ?? [])
		.filter((message) => message.role === "toolResult" && message.toolName === "codemode")
	const discoveryResult = codemodeSchema.parse(codemodeMessages[0])
	const codemode = codemodeSchema.parse(codemodeMessages.at(-1))
	const discovery = z
		.object({
			declarations: z.record(z.string(), z.string()),
			discovered: z.record(z.string(), z.array(z.string())),
		})
		.parse(JSON.parse(discoveryResult.content[1].text))
	const evidence = z
		.object({
			profiles: z.record(
				z.string(),
				z.object({ emailUppercase: z.string(), logId: z.string().min(1) }),
			),
		})
		.parse(JSON.parse(codemode.content[1].text))
	for (const [slug, account] of Object.entries(assignments)) {
		const name = `${slug}__GMAIL_GET_PROFILE`
		expect(discovery.discovered[slug]).toContain(name)
		expect(discovery.declarations[slug]).toContain("user_id")
		expect(discovery.declarations[slug]).toContain("emailAddress")
		expect(discovery.declarations[slug]).toContain("logId")
		expect(codemode.details.calls).toContainEqual(
			expect.objectContaining({ name, status: "ok" }),
		)
		expect(evidence.profiles[slug]?.emailUppercase).toBe(
			z.email().parse(account.display_name).toUpperCase(),
		)
	}
	expect(discovery.discovered.work_email).not.toContain(
		"personal_email__GMAIL_GET_PROFILE",
	)
	expect(discovery.discovered.personal_email).not.toContain(
		"work_email__GMAIL_GET_PROFILE",
	)
	console.info("Native Pi Composio profile bindings", {
		accounts: Object.fromEntries(
			Object.entries(assignments).map(([slug, account]) => [slug, account.id]),
		),
		jobId: job.id,
		logIds: Object.fromEntries(
			Object.entries(evidence.profiles).map(([slug, profile]) => [slug, profile.logId]),
		),
	})
}, 240_000)
