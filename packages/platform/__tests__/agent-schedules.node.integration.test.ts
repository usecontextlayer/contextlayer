import { execFile as execFileCallback } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { AssistantEntry, UserEntry } from "@earendil-works/pi-durable"
import { writeDatabase, writeDatabaseProject } from "@tests/database-project"
import { provisioningTest as test } from "@tests/integration"
import { DEVELOPMENT_ORGANIZATION_SLUG } from "@usecontextlayer/dev-env/env"
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
	agentJobMessageSchema,
	agentJobOperationSchema,
	agentJobResultSchema,
	agentJobSessionSchema,
	agentJobUsageSchema,
	agentRuntimeScheduleSchema,
	scheduledAgentRunSchema,
} from "@/agents.schema"
import { organizationSchema } from "@/auth.server"
import { loadSharedSecret } from "@/secrets.server"
import { slateSchema } from "@/slates.schema"

const execFile = promisify(execFileCallback)

for (const mode of ["default", "owner", "viewer"] as const) {
	test(`API jobs record the ${mode} model selection`, async ({
		directory,
		platform,
		webEnv,
		webSession,
	}) => {
		const { origin, worker } = platform
		const headers = new Headers(webSession.headers)
		headers.set("origin", origin)
		headers.set("content-type", "application/json")
		const organizationsResponse = await fetch(
			`${webEnv.BETTER_AUTH_URL}/api/platform/organizations`,
			{ headers: webSession.headers },
		)
		expect(organizationsResponse.status).toBe(200)
		const organization = z
			.object({ organizations: z.array(organizationSchema) })
			.parse(await organizationsResponse.json())
			.organizations.find((item) => item.slug === DEVELOPMENT_ORGANIZATION_SLUG)
		if (!organization) throw new Error("Initialize the local development organization")
		const owner = { id: organization.id, type: "organization" } as const
		const viewer = { id: webSession.user.id, type: "personal" } as const
		let expectedModel = "claude-haiku-4-5"
		if (mode !== "default") {
			const [ownerModel, viewerModel] = await Promise.all([
				loadSharedSecret(platform.env, owner, "ANTHROPIC_MODEL"),
				loadSharedSecret(platform.env, viewer, "ANTHROPIC_MODEL"),
			])
			expect(ownerModel, "Configure distinct owner and viewer model IDs").not.toBe(
				viewerModel,
			)
			expect(viewerModel, "Configure a viewer model different from the default").not.toBe(
				expectedModel,
			)
			expectedModel = mode === "owner" ? ownerModel : viewerModel
		}
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
			const { ARTIFACTS } = await worker.getEnv()
			await ARTIFACTS.delete(slate.id)
		})
		const repo = await ARTIFACTS.get(slate.id)
		const { remote } = await repo.info()
		const token = await repo.createToken("write")
		await mkdir(join(directory, "agents/model"), { recursive: true })
		await mkdir(join(directory, "public"))
		await writeFile(
			join(directory, "public/slate.json"),
			JSON.stringify({ connections: {} }),
		)
		await writeFile(
			join(directory, "agents/model/slate.json"),
			JSON.stringify({
				connections: {},
				secrets: {
					ANTHROPIC_API_KEY: { mode: "owner" },
					...(mode === "default" ? {} : { ANTHROPIC_MODEL: { mode } }),
				},
			}),
		)
		await writeFile(
			join(directory, "agents/model/instructions.md"),
			"Answer briefly without using tools.\n",
		)
		const git = (...args: string[]) =>
			execFile("git", args, {
				cwd: directory,
				env: {
					...process.env,
					GIT_CONFIG_COUNT: "1",
					GIT_CONFIG_GLOBAL: join(directory, "gitconfig"),
					GIT_CONFIG_KEY_0: "http.extraHeader",
					GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token.plaintext}`,
					GIT_TERMINAL_PROMPT: "0",
				},
			})
		await git("init", "-b", "main")
		await git("config", "user.name", "Pi Model Acceptance")
		await git("config", "user.email", "pi-model-test@example.com")
		await git("add", "agents", "public")
		await git("-c", "commit.gpgsign=false", "commit", "-m", "Declare agent model")
		await git("push", remote, "main")
		const inventory = await fetch(`${origin}/api/slates/${slate.id}/resources/list`, {
			body: "{}",
			headers,
			method: "POST",
		})
		expect(inventory.status).toBe(200)
		const configured = slateResourcesSchema.parse(await inventory.json()).resources
		expect(configured.secrets.ANTHROPIC_API_KEY?.owner).toEqual(owner)
		if (mode === "default") expect(configured.secrets.ANTHROPIC_MODEL).toBeUndefined()
		else
			expect(configured.secrets.ANTHROPIC_MODEL?.owner).toEqual(
				mode === "owner" ? owner : viewer,
			)
		const url = `${origin}/api/slates/${slate.id}/agents/model/jobs`
		const submitted = await fetch(url, {
			body: JSON.stringify({ prompt: "Say hello in one sentence." }),
			headers,
			method: "POST",
		})
		expect(submitted.status).toBe(202)
		const api = agentJobCreationSchema.parse(await submitted.json())
		expect(api.job.metadata).toEqual({
			actor: { id: viewer.id, type: "user" },
			trigger: { type: "api" },
		})
		const completed = await fetch(`${url}/${api.job.id}/result`, { headers })
		expect(completed.status).toBe(200)
		const result = agentJobResultSchema.parse(await completed.json())
		expect(result.status, result.reason).toBe("done")
		const response = await fetch(
			`${url}/${api.job.id}/sessions/${result.session}/messages`,
			{ headers },
		)
		expect(response.status).toBe(200)
		const assistants = z
			.array(agentJobMessageSchema)
			.parse(await response.json())
			.filter((entry) => entry.kind === AssistantEntry.kind)
			.flatMap((entry) => entry.model ?? [])
			.filter((message) => message.role === "assistant")
		expect(assistants.length).toBeGreaterThan(0)
		for (const assistant of assistants)
			expect(assistant).toMatchObject({ model: expectedModel, provider: "anthropic" })
		const usageResponse = await fetch(`${url}/${api.job.id}/usage`, { headers })
		expect(usageResponse.status).toBe(200)
		const usage = agentJobUsageSchema.parse(await usageResponse.json())
		expect(Object.keys(usage.models)).toEqual([`anthropic/${expectedModel}`])
		const deleted = await fetch(`${url}/${api.job.id}`, { headers, method: "DELETE" })
		expect(deleted.status).toBe(204)
	}, 300_000)
}

test("members' deployed cron jobs use viewer resources and retain results after Worker reload", async ({
	db,
	directory: dir,
	platform,
	provisioning,
	webEnv,
	webSession,
}) => {
	const { origin, worker } = platform
	const { user } = webSession
	const headers = new Headers(webSession.headers)
	headers.set("origin", origin)
	headers.set("content-type", "application/json")
	const post = (body: unknown) => ({
		body: JSON.stringify(body),
		headers,
		method: "POST",
	})
	const organizationsResponse = await fetch(
		`${webEnv.BETTER_AUTH_URL}/api/platform/organizations`,
		{ headers: webSession.headers },
	)
	expect(organizationsResponse.status).toBe(200)
	const organization = z
		.object({ organizations: z.array(organizationSchema) })
		.parse(await organizationsResponse.json())
		.organizations.find((item) => item.slug === DEVELOPMENT_ORGANIZATION_SLUG)
	if (!organization) throw new Error("Initialize the local development organization")
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
	const { AGENTS, ARTIFACTS } = await worker.getEnv()
	const { PROVISIONING } = await provisioning.worker.getEnv()
	const checkouts = []
	for (const [index, slate] of slates.entries()) {
		const repo = await ARTIFACTS.get(slate.id)
		const { remote } = await repo.info()
		const token = await repo.createToken("write")
		const gitEnv = {
			...process.env,
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
			GIT_CONFIG_KEY_0: "http.extraHeader",
			GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token.plaintext}`,
			GIT_TERMINAL_PROMPT: "0",
		}
		const checkout = join(dir, slate.id)
		await mkdir(join(checkout, "agents/daily-summary/schedules"), { recursive: true })
		await mkdir(join(checkout, "public"))
		const git = async (...args: string[]) =>
			(await execFile("git", args, { cwd: checkout, env: gitEnv })).stdout.trim()
		await git("init", "-b", "main")
		await git("config", "user.name", "Scheduled Agent Test")
		await git("config", "user.email", "agent-test@example.com")
		await git("remote", "add", "origin", remote)
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
			"Use only read-only operations on connected accounts. Never send messages, create, update or delete account data. Do not read email messages or disclose credentials or account details. Writes to the declared disposable test databases are authorized.\n",
		)
		const scheduleFile = join(checkout, "agents/daily-summary/schedules/profile.md")
		await writeFile(
			scheduleFile,
			'---\ncron: "0 0 1 1 *"\n---\nInspect only mailbox profile metadata with a read-only Gmail tool. Report only whether it succeeded.\n',
		)
		await writeDatabaseProject(checkout)
		for (const slug of ["inbox", "reports"]) await writeDatabase(checkout, slug)
		await git("add", ".")
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
		const prepared = await PROVISIONING.prepare(slate.id, await git("rev-parse", "HEAD"))
		await PROVISIONING.migrate(prepared)
		await PROVISIONING.provisionSchedules(prepared)
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
	for (const { slate, git, memberInstance, scheduleFile } of checkouts) {
		const firing = new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 60_000)
		const cron = `${firing.getUTCMinutes()} ${firing.getUTCHours()} ${firing.getUTCDate()} ${firing.getUTCMonth() + 1} *`
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
		const prepared = await PROVISIONING.prepare(slate.id, await git("rev-parse", "HEAD"))
		await PROVISIONING.provisionSchedules(prepared)
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
	const { job: apiJob, receipt } = agentJobCreationSchema.parse(await submitted.json())
	const completedApi = await waitForResult(apiUrl, apiJob.id)
	expect(completedApi.operationId).toBe(receipt.operationId)
	expect(receipt.operationId).not.toBe(apiJob.id)
	const listedApi = await fetch(apiUrl, { headers })
	const apiEntry = jobs
		.parse(await listedApi.json())
		.jobs.find((job) => job.id === apiJob.id)
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
		apiJob.id,
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

test("authored cron creates a fresh job and retains its result independently of the schedule", async ({
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
		const { ARTIFACTS } = await worker.getEnv()
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
		"Answer briefly without using tools.\n",
	)
	const firing = new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 60_000)
	const cron = `${firing.getUTCMinutes()} ${firing.getUTCHours()} ${firing.getUTCDate()} ${firing.getUTCMonth() + 1} *`
	const prompt = "Say hello in one sentence."
	await writeFile(
		join(directory, "agents/brief/schedules/greeting.md"),
		`---\ncron: "${cron}"\n---\n${prompt}\n`,
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
	const commit = (await git("rev-parse", "HEAD")).stdout.trim()
	await writeFile(
		join(directory, "agents/brief/schedules/greeting.md"),
		`---\ncron: "${cron}"\n---\nThis prompt belongs to a later push.\n`,
	)
	await git("add", "agents")
	await git("-c", "commit.gpgsign=false", "commit", "-m", "Push a later schedule")
	await git("push", remote, "main")
	const prepared = await PROVISIONING.prepare(slate.id, commit)
	expect(prepared.snapshot.commit).toBe(commit)
	await PROVISIONING.migrate(prepared)
	await PROVISIONING.provisionSchedules(prepared)
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
			prompt: expect.stringContaining(prompt),
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

	expect(completed.status, completed.ok ? undefined : await completed.text()).toBe(200)
	const result = agentJobResultSchema.strict().parse(await completed.json())
	console.info("Real scheduled Pi result", result)
	expect(result.operationId).not.toBe(jobId)
	expect(result.status, result.reason).toBe("done")
	expect(result.text?.length).toBeGreaterThan(0)
	const operationResponse = await fetch(`${url}/${jobId}/operation`, { headers })
	expect(operationResponse.status).toBe(200)
	expect(agentJobResultSchema.strict().parse(await operationResponse.json())).toEqual(
		result,
	)
	const sessionResponse = await fetch(`${url}/${jobId}/sessions`, { headers })
	expect(sessionResponse.status).toBe(200)
	const sessions = z.array(agentJobSessionSchema).parse(await sessionResponse.json())
	expect(sessions.map((session) => session.id)).toEqual([result.session])
	const messageResponse = await fetch(
		`${url}/${jobId}/sessions/${result.session}/messages`,
		{
			headers,
		},
	)
	expect(messageResponse.status).toBe(200)
	const messages = z.array(agentJobMessageSchema).parse(await messageResponse.json())
	const userEntries = messages.filter((entry) => entry.kind === UserEntry.kind)
	expect(userEntries).toHaveLength(1)
	expect(userEntries[0]?.model).toContainEqual(
		expect.objectContaining({ content: schedule.payload.prompt, role: "user" }),
	)
	const listed = await fetch(url, { headers })
	expect(listed.status).toBe(200)
	expect(catalogSchema.parse(await listed.json()).jobs).toContainEqual(entry)
	await platform.harness.update((current) => current)
	const retainedResult = await fetch(`${url}/${jobId}/result`, { headers })
	expect(retainedResult.status).toBe(200)
	expect(agentJobResultSchema.strict().parse(await retainedResult.json())).toEqual(result)
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
