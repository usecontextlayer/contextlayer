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
import { type AgentJob, agentJobSchema, scheduledAgentRunSchema } from "@/agents.schema"
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
		).toEqual([{ slate_id: slate.id, user_id: user.id }])
	}
	const [joinedBeforeProvisioning, joinedAfterProvisioning] = slates
	if (!joinedBeforeProvisioning || !joinedAfterProvisioning)
		throw new Error("Expected scheduled test slates")
	await db
		.deleteFrom("slate_member")
		.where("slate_id", "=", joinedAfterProvisioning.id)
		.execute()
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
		expect(refusal.status).toBe(index === 0 ? 409 : 403)
		if (index === 0)
			expect(await refusal.json()).toEqual({
				reason: "connection-required",
				slug: "mail",
			})
		expect(
			(
				await fetch(
					`${origin}/api/slates/${slate.id}/connections/assign`,
					post({ connection_id: account.id, slug: "mail" }),
				)
			).status,
		).toBe(200)
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
	const joined = await fetch(`${origin}/api/slates/${joinedAfterProvisioning.id}/join`, {
		headers,
		method: "POST",
	})
	expect(joined.status).toBe(200)
	expect(await joined.json()).toEqual({
		slate_id: joinedAfterProvisioning.id,
		user_id: user.id,
	})
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
	const jobs = z.object({ jobs: z.array(agentJobSchema) })
	const saved: { url: string; job: AgentJob }[] = []
	for (const { slate } of checkouts) {
		const url = `${origin}/api/slates/${slate.id}/agents/daily-summary/jobs`
		let completed: AgentJob | undefined
		await expect
			.poll(
				async () => {
					const response = await fetch(url, { headers })
					expect(response.status).toBe(200)
					completed = jobs
						.parse(await response.json())
						.jobs.find((job) => job.source === "schedule")
					return completed?.status
				},
				{ interval: 1000, timeout: 240_000 },
			)
			.toBeOneOf(["completed", "error", "aborted"])
		console.info("Scheduled agent job", {
			id: completed?.id,
			slate_id: slate.id,
			source: completed?.source,
			status: completed?.status,
		})
		expect(completed?.error).toBeUndefined()
		expect(completed?.status).toBe("completed")
		expect(completed?.result?.length).toBeGreaterThan(0)
		if (!completed) throw new Error("Expected a completed scheduled job")
		expect(completed.instance_name).toBe(
			getAgentInstanceName(slate.id, "daily-summary", { id: user.id, type: "user" }),
		)
		saved.push({ job: completed, url })
	}
	const apiUrl = `${origin}/api/slates/${joinedBeforeProvisioning.id}/agents/daily-summary/jobs`
	const submitted = await fetch(
		apiUrl,
		post({
			prompt: `Use database_query to insert a row into updates in both inbox and reports with id api-proof, kind proof, body ${joinedBeforeProvisioning.id}, and created_at 2. Report only whether the API task completed. Disclose no account details.`,
		}),
	)
	expect(submitted.status).toBe(202)
	const apiJob = agentJobSchema.parse(await submitted.json())
	expect(apiJob.source).toBe("api")
	expect(apiJob.instance_name).toBe(saved[0]?.job.instance_name)
	const detailUrl = (url: string, job: AgentJob) =>
		`${url}/${job.id}?instance_name=${encodeURIComponent(job.instance_name)}`
	let completedApi: AgentJob | undefined
	await expect
		.poll(
			async () => {
				const response = await fetch(detailUrl(apiUrl, apiJob), { headers })
				expect(response.status).toBe(200)
				completedApi = agentJobSchema.parse(await response.json())
				return completedApi.status
			},
			{ interval: 1000, timeout: 120_000 },
		)
		.toBeOneOf(["completed", "error", "aborted"])
	expect(completedApi?.error).toBeUndefined()
	expect(completedApi?.status).toBe("completed")
	expect(completedApi?.result?.length).toBeGreaterThan(0)
	if (!completedApi) throw new Error("Expected a completed API job")
	saved.push({ job: completedApi, url: apiUrl })
	await platform.harness.update((current) => current)
	for (const { job, url } of saved) {
		const response = await fetch(detailUrl(url, job), { headers })
		expect(response.status).toBe(200)
		expect(agentJobSchema.parse(await response.json())).toEqual(job)
		const listed = await fetch(url, { headers })
		expect(listed.status).toBe(200)
		expect(jobs.parse(await listed.json()).jobs).toContainEqual(job)
	}
	const { DATABASES } = await worker.getEnv()
	for (const { slate, databases } of checkouts) {
		for (const database of Object.values(databases)) {
			const rows = await DATABASES.getByName(database.instance_name).query(
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
		saved.map(({ job }) => ({ id: job.id, source: job.source, status: job.status })),
	)
}, 480_000)
