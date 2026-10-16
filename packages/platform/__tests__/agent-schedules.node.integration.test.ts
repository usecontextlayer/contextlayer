import { execFile as execFileCallback } from "node:child_process"
import { cp, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { provisioningTest as test } from "@tests/integration"
import { connectionsSchema } from "@usecontextlayer/shared/connections"
import { slateResourcesSchema } from "@usecontextlayer/shared/slate-resources"
import { getAgentByName } from "agents/routing"
import { expect } from "vitest"
import { z } from "zod"
import { getAgentInstanceName } from "@/agent-instance"
import {
	type AgentJobEntry,
	type AgentJobOperation,
	agentJobCreationSchema,
	agentJobEntrySchema,
	agentJobOperationSchema,
	agentJobResultSchema,
	agentRuntimeScheduleSchema,
	scheduledAgentRunSchema,
} from "@/agents.schema"
import { slateSchema } from "@/slates.schema"

const execFile = promisify(execFileCallback)
test("members' deployed cron jobs use viewer resources and retain results after Worker reload", async ({
	cliEnv,
	db,
	directory: dir,
	identity,
	organization,
	platform,
	provisioning,
}) => {
	const post = (body: unknown) => ({
		body: JSON.stringify(body),
		headers: { ...headers, "content-type": "application/json" },
		method: "POST",
	})
	const { origin, worker } = platform
	const { headers, user } = identity
	const organizationSlug = organization.slug
	const organizationId = organization.id
	await using resources = new AsyncDisposableStack()
	const slates = []
	for (let index = 0; index < 2; index++) {
		const response = await fetch(
			`${origin}/api/slates`,
			post({ organization_slug: organizationSlug }),
		)
		expect(response.status).toBe(201)
		const slate = slateSchema.parse(await response.json())
		resources.defer(async () => {
			const { ARTIFACTS } = await worker.getEnv()
			await ARTIFACTS.delete(slate.id)
		})
		slates.push(slate)
		expect(slate.owner_organization_id).toBe(organizationId)
		expect(
			await db
				.selectFrom("slate_member")
				.selectAll()
				.where("slate_id", "=", slate.id)
				.execute(),
		).toEqual([])
	}
	const [joinedBeforeProvisioning, joinedAfterProvisioning] = slates
	if (!joinedBeforeProvisioning || !joinedAfterProvisioning)
		throw new Error("Expected scheduled test slates")
	const missing = await fetch(
		`${origin}/api/slates/${joinedBeforeProvisioning.id}/agents/missing/jobs`,
		post({ prompt: "Read-only proof." }),
	)
	expect(missing.status).toBe(404)
	const accounts = await fetch(`${origin}/api/connections?toolkit=gmail`, { headers })
	expect(accounts.status).toBe(200)
	const account = connectionsSchema.parse(await accounts.json()).connections[0]
	if (!account)
		throw new Error("Expected the existing active personal Gmail connected account")
	const { AGENTS } = await worker.getEnv()
	const { PROVISIONING } = await provisioning.worker.getEnv()
	const cli = join(import.meta.dirname, "../../cli/dist/cli.mjs")
	const gitEnv = {
		...process.env,
		...cliEnv,
		GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
		GIT_TERMINAL_PROMPT: "0",
	}
	await execFile(
		"git",
		["config", "--global", `credential.${origin}/git.helper`, `${cli} git-credential`],
		{ cwd: dir, env: gitEnv },
	)
	const checkouts = []
	for (const [index, slate] of slates.entries()) {
		const checkout = join(dir, slate.id)
		await mkdir(join(checkout, "agents/daily-summary/schedules"), { recursive: true })
		await mkdir(join(checkout, "public"))
		const git = async (...args: string[]) =>
			(await execFile("git", args, { cwd: checkout, env: gitEnv })).stdout.trim()
		await git("init", "-b", "main")
		await git("config", "user.name", "Scheduled Agent Test")
		await git("config", "user.email", "agent-test@example.com")
		await git("remote", "add", "origin", `${origin}/git/${slate.id}`)
		await writeFile(
			join(checkout, "public/slate.json"),
			JSON.stringify({
				connections: { mail: { mode: "viewer", toolkit: "gmail" } },
				databases: { reports: { mode: "owner" } },
			}),
		)
		await writeFile(
			join(checkout, "agents/daily-summary/slate.json"),
			JSON.stringify({
				connections: { mail: { mode: "viewer", toolkit: "gmail" } },
				databases: { inbox: { mode: "viewer" }, reports: { mode: "owner" } },
				secrets: { ANTHROPIC_API_KEY: { mode: index === 0 ? "owner" : "viewer" } },
			}),
		)
		await writeFile(
			join(checkout, "agents/daily-summary/instructions.md"),
			"Use only read-only operations. Never send messages, create, update or delete account data. Do not read email messages or disclose credentials or account details.\n",
		)
		const scheduleFile = join(checkout, "agents/daily-summary/schedules/profile.md")
		await writeFile(
			scheduleFile,
			'---\ncron: "0 0 1 1 *"\n---\nInspect only mailbox profile metadata with a read-only Gmail tool. Report only whether it succeeded.\n',
		)
		for (const slug of ["inbox", "reports"])
			await cp(
				new URL("../../cli/template/databases/updates/migrations/", import.meta.url),
				join(checkout, "databases", slug, "migrations"),
				{ recursive: true },
			)
		await git("add", "public", "agents", "databases")
		await git("-c", "commit.gpgsign=false", "commit", "-m", "Deploy scheduled agent")
		await git("push", "origin", "main")
		const refusal = await fetch(
			`${origin}/api/slates/${slate.id}/agents/daily-summary/jobs`,
			post({ prompt: "Read-only proof." }),
		)
		expect(refusal.status).toBe(409)
		expect(await refusal.json()).toEqual({ reason: "connection-required", slug: "mail" })
		if (index === 0) {
			expect(
				(
					await fetch(
						`${origin}/api/slates/${slate.id}/connections/assign`,
						post({ connection_id: account.id, slug: "mail" }),
					)
				).status,
			).toBe(200)
		}
		const inventory = await fetch(
			`${origin}/api/slates/${slate.id}/resources/list`,
			post({}),
		)
		expect(inventory.status).toBe(200)
		const { resources } = slateResourcesSchema.parse(await inventory.json())
		expect(resources.connections.mail?.owner).toEqual({ id: user.id, type: "personal" })
		expect(resources.secrets.ANTHROPIC_API_KEY?.owner).toEqual(
			index === 0
				? { id: organizationId, type: "organization" }
				: { id: user.id, type: "personal" },
		)
		await PROVISIONING.provision(slate.id)
		const memberInstance = await getAgentByName(
			AGENTS,
			getAgentInstanceName(slate.id, "daily-summary", { id: user.id, type: "user" }),
		)
		const appInstance = await getAgentByName(
			AGENTS,
			getAgentInstanceName(slate.id, "daily-summary", { type: "app" }),
		)
		expect(await appInstance.listSchedules()).toEqual([])
		expect(await memberInstance.listSchedules()).toHaveLength(index === 0 ? 1 : 0)
		checkouts.push({
			databases: resources.databases,
			git,
			memberInstance,
			scheduleFile,
			slate,
		})
	}
	const completedSetup = await fetch(
		`${origin}/api/slates/${joinedAfterProvisioning.id}/connections/assign`,
		post({ connection_id: account.id, slug: "mail" }),
	)
	expect(completedSetup.status).toBe(200)
	expect(await completedSetup.json()).toEqual({ connection_id: account.id, slug: "mail" })
	expect(await checkouts[1]?.memberInstance.listSchedules()).toHaveLength(1)
	const firing = new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 60_000)
	const cron = `${firing.getUTCMinutes()} ${firing.getUTCHours()} ${firing.getUTCDate()} ${firing.getUTCMonth() + 1} *`
	for (const { slate, git, memberInstance, scheduleFile } of checkouts) {
		await writeFile(
			scheduleFile,
			`---\ncron: "${cron}"\n---\nInspect only mailbox profile metadata with a read-only Gmail tool. Use database_query to insert a row into updates in both inbox and reports with id scheduled-proof, kind proof, body ${slate.id}, and created_at 1. Report only whether this refreshed scheduled task succeeded.\n`,
		)
		await git("add", "agents")
		await git(
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-m",
			"Refresh scheduled prompt and cron",
		)
		await git("push", "origin", "main")
		await PROVISIONING.provision(slate.id)
		const schedules = z
			.array(z.object({ payload: scheduledAgentRunSchema }))
			.parse(await memberInstance.listSchedules())
		expect(schedules).toHaveLength(1)
		expect(schedules[0]?.payload).toMatchObject({
			actor: { id: user.id, type: "user" },
			prompt: expect.stringContaining("refreshed scheduled task"),
			slateId: slate.id,
		})
	}
	const jobs = z.object({ jobs: z.array(agentJobEntrySchema.strict()) })
	const saved: { url: string; job: AgentJobEntry; result: AgentJobOperation }[] = []
	const waitForResult = async (url: string, id: string) => {
		let result: AgentJobOperation | undefined
		await expect
			.poll(
				async () => {
					const response = await fetch(`${url}/${id}/operation`, { headers })
					expect(response.status).toBe(200)
					result = agentJobOperationSchema.parse(await response.json())
					return result.status
				},
				{ interval: 1000, timeout: 240_000 },
			)
			.toBeOneOf(["done", "unanswered"])
		const settled = agentJobResultSchema.parse(result)
		expect(settled.status, settled.reason).toBe("done")
		return settled
	}
	for (const { slate } of checkouts) {
		const url = `${origin}/api/slates/${slate.id}/agents/daily-summary/jobs`
		let entry: AgentJobEntry | undefined
		await expect
			.poll(
				async () => {
					const response = await fetch(url, { headers })
					expect(response.status).toBe(200)
					entry = jobs.parse(await response.json()).jobs[0]
					return entry !== undefined
				},
				{ interval: 1000, timeout: 240_000 },
			)
			.toBe(true)
		if (!entry) throw new Error("Expected the scheduled job catalog entry")
		const result = await waitForResult(url, entry.id)
		saved.push({ job: entry, result, url })
	}
	const apiUrl = `${origin}/api/slates/${joinedBeforeProvisioning.id}/agents/daily-summary/jobs`
	const submitted = await fetch(
		apiUrl,
		post({
			prompt: `Use database_query to insert a row into updates in both inbox and reports with id api-proof, kind proof, body ${joinedBeforeProvisioning.id}, and created_at 2. Report only whether the API task completed. Disclose no account details.`,
		}),
	)
	expect(submitted.status).toBe(202)
	const { receipt } = agentJobCreationSchema.parse(await submitted.json())
	const completedApi = await waitForResult(apiUrl, receipt.operationId)
	const listedApi = await fetch(apiUrl, { headers })
	const apiEntry = jobs
		.parse(await listedApi.json())
		.jobs.find((job) => job.id === receipt.operationId)
	if (!apiEntry) throw new Error("Expected the API job catalog entry")
	saved.push({ job: apiEntry, result: completedApi, url: apiUrl })
	await platform.harness.update((current) => current)
	const bindings = await worker.getEnv()
	for (const { job, url, result } of saved) {
		const response = await fetch(`${url}/${job.id}/result`, { headers })
		expect(response.status).toBe(200)
		const detail = agentJobResultSchema.parse(await response.json())
		expect(detail).toEqual(result)
		expect(detail.text?.length).toBeGreaterThan(0)
		const listed = await fetch(url, { headers })
		expect(listed.status).toBe(200)
		expect(jobs.parse(await listed.json()).jobs).toContainEqual(job)
	}
	const listed = await fetch(apiUrl, { headers })
	expect(listed.status).toBe(200)
	expect(jobs.parse(await listed.json()).jobs.map((job) => job.id)).toEqual([
		completedApi.operationId,
		saved[0]?.job.id,
	])
	for (const { slate, databases } of checkouts) {
		for (const database of Object.values(databases)) {
			const rows = await bindings.DATABASES.getByName(database.instance_name).query(
				"SELECT id, body FROM updates ORDER BY created_at",
			)
			expect(rows.rows).toEqual(
				slate.id === joinedBeforeProvisioning.id
					? [
							["scheduled-proof", slate.id],
							["api-proof", slate.id],
						]
					: [["scheduled-proof", slate.id]],
			)
		}
	}
	console.info(
		"Agent jobs retained after Worker reload",
		saved.map(({ job, result }) => ({ id: job.id, status: result.status })),
	)
}, 480_000)

test("authored cron starts a fresh Pi job visible through the API", async ({
	directory,
	platform,
	provisioning,
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
	await mkdir(join(directory, "agents/brief/schedules"), { recursive: true })
	await mkdir(join(directory, "public"))
	await writeFile(
		join(directory, "public/slate.json"),
		JSON.stringify({ connections: {} }),
	)
	await writeFile(
		join(directory, "agents/brief/slate.json"),
		JSON.stringify({
			connections: {},
			secrets: { ANTHROPIC_API_KEY: { mode: "owner" } },
		}),
	)
	await writeFile(
		join(directory, "agents/brief/instructions.md"),
		"You are a concise assistant. Prefix answers with PI_CRON_STORY2.\n",
	)
	const firing = new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 60_000)
	const cron = `${firing.getUTCMinutes()} ${firing.getUTCHours()} ${firing.getUTCDate()} ${firing.getUTCMonth() + 1} *`
	await writeFile(
		join(directory, "agents/brief/schedules/greeting.md"),
		`---\ncron: "${cron}"\n---\nWhat is 7 multiplied by 13? Give a short scheduled greeting.\n`,
	)
	const gitEnv = {
		...process.env,
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_GLOBAL: join(directory, "gitconfig"),
		GIT_CONFIG_KEY_0: "http.extraHeader",
		GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token.plaintext}`,
		GIT_TERMINAL_PROMPT: "0",
	}
	const git = (...args: string[]) =>
		execFile("git", args, { cwd: directory, env: gitEnv })
	await git("init", "-b", "main")
	await git("config", "user.name", "Pi Cron Acceptance")
	await git("config", "user.email", "pi-cron-test@example.com")
	await git("add", "agents", "public")
	await git(
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-m",
		"Author scheduled Pi acceptance agent",
	)
	await git("push", remote, "main")
	const url = `${origin}/api/slates/${slate.id}/agents/brief/jobs`
	const catalogSchema = z.object({ jobs: z.array(agentJobEntrySchema.strict()) }).strict()
	const before = await fetch(url, { headers })
	expect(before.status).toBe(200)
	expect(catalogSchema.parse(await before.json()).jobs).toEqual([])
	const { PROVISIONING } = await provisioning.worker.getEnv()
	await PROVISIONING.provision(slate.id)
	const scheduleUrl = `${origin}/api/slates/${slate.id}/agents/brief/schedules`
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
			prompt: expect.stringContaining(
				"What is 7 multiplied by 13? Give a short scheduled greeting.",
			),
			schedule: "greeting",
			slateId: slate.id,
		},
		type: "cron",
	})
	const scheduleDetail = await fetch(`${scheduleUrl}/${schedule.id}`, { headers })
	expect(scheduleDetail.status).toBe(200)
	expect(agentRuntimeScheduleSchema.parse(await scheduleDetail.json())).toEqual(schedule)
	console.info("Authored cron provisioned", {
		cron,
		firing: firing.toISOString(),
		slateId: slate.id,
	})
	let entry: AgentJobEntry | undefined
	await expect
		.poll(
			async () => {
				const response = await fetch(url, { headers })
				expect(response.status).toBe(200)
				entry = catalogSchema.parse(await response.json()).jobs[0]
				return entry !== undefined
			},
			{ interval: 1000, timeout: 180_000 },
		)
		.toBe(true)
	if (!entry) throw new Error("Expected a cron-created job catalog entry")
	const jobId = entry.id
	expect(entry.metadata).toEqual({
		actor: { type: "app" },
		trigger: { schedule: "greeting", scheduleId: schedule.id, type: "schedule" },
	})
	const detail = await fetch(`${url}/${jobId}`, { headers })
	expect(detail.status).toBe(200)
	expect(agentJobEntrySchema.strict().parse(await detail.json())).toEqual(entry)
	const matching = await fetch(`${url}?schedule=greeting`, { headers })
	expect(matching.status).toBe(200)
	expect(catalogSchema.parse(await matching.json()).jobs).toEqual([entry])
	const other = await fetch(`${url}?schedule=other`, { headers })
	expect(other.status).toBe(200)
	expect(catalogSchema.parse(await other.json()).jobs).toEqual([])
	const completed = await fetch(`${url}/${jobId}/result`, { headers })
	expect(completed.status).toBe(200)
	const result = agentJobResultSchema.strict().parse(await completed.json())
	console.info("Real scheduled Pi result", result)
	expect(result.operationId).toBe(jobId)
	expect(result.status, result.reason).toBe("done")
	expect(result.text?.length).toBeGreaterThan(0)
	const listed = await fetch(url, { headers })
	expect(listed.status).toBe(200)
	expect(catalogSchema.parse(await listed.json()).jobs).toContainEqual(entry)
	const deleted = await fetch(`${url}/${jobId}`, { headers, method: "DELETE" })
	expect(deleted.status).toBe(204)
	const missing = await fetch(`${url}/${jobId}`, { headers })
	expect(missing.status).toBe(404)
	const empty = await fetch(`${url}?schedule=greeting`, { headers })
	expect(empty.status).toBe(200)
	expect(catalogSchema.parse(await empty.json()).jobs).toEqual([])
	const retainedSchedule = await fetch(`${scheduleUrl}/${schedule.id}`, { headers })
	expect(retainedSchedule.status).toBe(200)
	expect(agentRuntimeScheduleSchema.parse(await retainedSchedule.json())).toMatchObject({
		id: schedule.id,
		payload: schedule.payload,
	})
}, 300_000)
