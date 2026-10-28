import { execFile as execFileCallback } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { UserEntry } from "@earendil-works/pi-durable"
import { test } from "@tests/integration"
import seed from "@usecontextlayer/dev-env/seed.json" with { type: "json" }
import { accountsSchema } from "@usecontextlayer/shared/accounts"
import { slateResourcesSchema } from "@usecontextlayer/shared/slate-resources"
import { getAgentByName } from "agents/routing"
import { expect } from "vitest"
import { z } from "zod"
import { getAgentInstanceName } from "@/agent-instance"
import {
	type AgentJobEntry,
	agentJobEntrySchema,
	agentJobMessageSchema,
	agentJobResultSchema,
	agentJobSessionSchema,
	agentRuntimeScheduleSchema,
} from "@/agents.schema"
import { slateSchema } from "@/slates.schema"

const execFile = promisify(execFileCallback)

test("member schedules retain viewer actor and trigger provenance", async ({
	directory,
	platform,
	provisioning,
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
		post({ organization_slug: seed.web.organization.slug }),
	)
	expect(created.status).toBe(201)
	const slate = slateSchema.parse(await created.json())
	const { AGENTS, ARTIFACTS } = await worker.getEnv()
	await using resources = new AsyncDisposableStack()
	resources.defer(async () => {
		await ARTIFACTS.delete(slate.id)
	})
	const accountsResponse = await fetch(`${origin}/api/accounts?toolkit=gmail`, {
		headers,
	})
	expect(accountsResponse.status).toBe(200)
	const account = accountsSchema.parse(await accountsResponse.json()).accounts[0]
	if (!account) throw new Error("Connect a Gmail account to the DevEnv user")
	const repo = await ARTIFACTS.get(slate.id)
	const { remote } = await repo.info()
	const token = await repo.createToken("write")
	await mkdir(join(directory, "agents/profile/schedules"), { recursive: true })
	await mkdir(join(directory, "public"))
	await writeFile(
		join(directory, "public/slate.json"),
		JSON.stringify({ connections: {} }),
	)
	await writeFile(
		join(directory, "agents/profile/slate.json"),
		JSON.stringify({
			connections: { mail: { mode: "viewer", toolkit: "gmail" } },
			secrets: { ANTHROPIC_API_KEY: { mode: "viewer" } },
		}),
	)
	await writeFile(
		join(directory, "agents/profile/instructions.md"),
		"Use only read-only profile metadata operations. Never read email messages or change account data. Report completion briefly without disclosing account details.\n",
	)
	await writeFile(
		join(directory, "agents/profile/schedules/profile.md"),
		'---\ncron: "0 0 1 1 *"\n---\nInspect mailbox profile metadata using the connected Gmail account.\n',
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
	await git("config", "user.name", "Scheduled Member Acceptance")
	await git("config", "user.email", "scheduled-member-test@example.com")
	await git("add", "agents", "public")
	await git("-c", "commit.gpgsign=false", "commit", "-m", "Declare member schedule")
	await git("push", remote, "main")
	await using workflows =
		await provisioning.worker.introspectWorkflow("MEMBER_PROVISIONING")
	const assigned = await fetch(
		`${origin}/api/slates/${slate.id}/connections/assign`,
		post({ account_id: account.id, slug: "mail" }),
	)
	expect(assigned.status).toBe(200)
	for (const instance of await workflows.get()) {
		await using workflow = instance
		await workflow.waitForStatus("complete")
	}
	const inventory = await fetch(
		`${origin}/api/slates/${slate.id}/resources/list`,
		post({}),
	)
	expect(inventory.status).toBe(200)
	const { resources: configured } = slateResourcesSchema.parse(await inventory.json())
	const viewer = { id: webSession.user.id, type: "personal" }
	expect(configured.connections.mail?.owner).toEqual(viewer)
	expect(configured.secrets.ANTHROPIC_API_KEY?.owner).toEqual(viewer)
	const member = await getAgentByName(
		AGENTS,
		getAgentInstanceName(slate.id, "profile", { id: webSession.user.id, type: "user" }),
	)
	const app = await getAgentByName(
		AGENTS,
		getAgentInstanceName(slate.id, "profile", { type: "app" }),
	)
	expect(await app.listSchedules()).toEqual([])
	const scheduled = await fetch(
		`${origin}/api/slates/${slate.id}/agents/profile/schedules`,
		{
			headers,
		},
	)
	expect(scheduled.status).toBe(200)
	const schedules = z.array(agentRuntimeScheduleSchema).parse(await scheduled.json())
	expect(schedules).toHaveLength(1)
	const schedule = schedules[0]
	if (!schedule) throw new Error("Expected the member schedule")
	const payload = schedule.payload
	expect(payload.actor).toEqual({ id: webSession.user.id, type: "user" })
	// The following case covers the native cron alarm; this case drives its production callback.
	await member.runScheduled(payload, schedule)
	const url = `${origin}/api/slates/${slate.id}/agents/profile/jobs`
	const listed = await fetch(url, { headers })
	expect(listed.status).toBe(200)
	const { jobs } = z
		.object({ jobs: z.array(agentJobEntrySchema) })
		.parse(await listed.json())
	expect(jobs).toHaveLength(1)
	const job = jobs[0]
	if (!job) throw new Error("Expected the scheduled member job")
	expect(job.metadata).toEqual({
		actor: payload.actor,
		trigger: { schedule: "profile", scheduleId: schedule.id, type: "schedule" },
	})
	const completed = await fetch(`${url}/${job.id}/result`, { headers })
	expect(completed.status).toBe(200)
	const result = agentJobResultSchema.parse(await completed.json())
	expect(result.status, result.reason).toBe("done")
	const deleted = await fetch(`${url}/${job.id}`, { headers, method: "DELETE" })
	expect(deleted.status).toBe(204)
}, 480_000)

test("authored cron jobs retain results after schedule removal and Worker reload", async ({
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
	// A recurring minute cannot be missed while the repository or runtime is preparing.
	const cron = "* * * * *"
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
	const { PROVISIONING, MEMBER_PROVISIONING } = await provisioning.worker.getEnv()
	const commit = (await git("rev-parse", "HEAD")).stdout.trim()
	await writeFile(
		join(directory, "agents/brief/schedules/greeting.md"),
		`---\ncron: "${cron}"\n---\nThis prompt belongs to a later push.\n`,
	)
	await git("add", "agents")
	await git("-c", "commit.gpgsign=false", "commit", "-m", "Push a later schedule")
	await git("push", remote, "main")
	const prepared = await PROVISIONING.prepare(slate.id, commit)
	{
		await using workflow = await provisioning.worker.introspectWorkflowInstance(
			"MEMBER_PROVISIONING",
			(await MEMBER_PROVISIONING.create({ params: prepared })).id,
		)
		await workflow.waitForStatus("complete")
	}
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
	expect(entry.metadata).toEqual({
		actor: { type: "app" },
		trigger: { schedule: "greeting", scheduleId: schedule.id, type: "schedule" },
	})
	const detail = await fetch(`${url}/${jobId}`, { headers })
	expect(detail.status).toBe(200)
	expect(agentJobEntrySchema.strict().parse(await detail.json())).toEqual(entry)
	const matching = await fetch(`${url}?schedule=greeting`, { headers })
	expect(matching.status).toBe(200)
	expect(catalogSchema.parse(await matching.json()).jobs).toContainEqual(entry)
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
	expect(catalogSchema.parse(await empty.json()).jobs.map(({ id }) => id)).not.toContain(
		jobId,
	)
}, 300_000)
