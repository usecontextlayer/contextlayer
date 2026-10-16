import { execFile as execFileCallback } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { test } from "@tests/integration"
import { expect } from "vitest"
import { z } from "zod"
import {
	agentJobCreationSchema,
	agentJobEntrySchema,
	agentJobOperationSchema,
	agentJobResultSchema,
} from "@/agents.schema"
import { slateSchema } from "@/slates.schema"

const execFile = promisify(execFileCallback)

test("API jobs expose native creation, catalog, results, abortion and deletion", async ({
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
			secrets: { ANTHROPIC_API_KEY: { mode: "viewer" } },
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
	for (const prompt of ["What is 47 multiplied by 19?", "Write a short greeting."]) {
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
		expect(receipt.operationId).toBe(job.id)
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
			operationId: job.id,
			session: receipt.session,
		})
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
	}
	expect(creations[0]?.job.id).not.toBe(creations[1]?.job.id)
	const catalogSchema = z.object({ jobs: z.array(agentJobEntrySchema.strict()) }).strict()
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
		expect(result.status, result.reason).toBe("done")
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
	expect(abortedResult.operationId).toBe(abortedCreation.job.id)
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
}, 240_000)
