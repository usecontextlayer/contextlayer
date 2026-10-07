import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import {
	type ProvisionedDatabases,
	provisionEphemeralDatabases,
} from "@usecontextlayer/db-infra/ephemeral"
import { appResourcesSchema } from "@usecontextlayer/shared/app-resources"
import { connectionsSchema } from "@usecontextlayer/shared/connections"
import { getAgentByName } from "agents/routing"
import { afterAll, beforeAll, expect, test } from "vitest"
import { createTestHarness } from "wrangler"
import { z } from "zod"
import { getAgentInstanceName } from "@/agent-instance"
import { type AgentJob, agentJobSchema, scheduledAgentRunSchema } from "@/agents.schema"
import { appSchema } from "@/apps.schema"
import type { PlatformEnv } from "@/context"
import { createPlatformDb } from "@/database"
import { migrateToLatest } from "@/database/migrate"
import { parsePlatformEnv } from "@/env"
import type { Publication } from "@/publication.server"

const execFile = promisify(execFileCallback)
const worker = createTestHarness()
const appIds: string[] = []
const folderNames = new Set<string>()
let databases: ProvisionedDatabases<"ctx_agent_schedules">
let db: ReturnType<typeof createPlatformDb>
let env: ReturnType<typeof parsePlatformEnv>
let dir: string
let origin: string
let headers: { authorization: string }

beforeAll(async () => {
	databases = await provisionEphemeralDatabases({
		migrators: { ctx_agent_schedules: migrateToLatest },
	})
	db = createPlatformDb(databases.urls.ctx_agent_schedules)
	env = parsePlatformEnv({
		...process.env,
		CTX_PLATFORM_DATABASE_URL: databases.urls.ctx_agent_schedules,
	})
	headers = {
		authorization: `Bearer ${z.string().min(1).parse(process.env.CTX_TEST_ACCESS_TOKEN)}`,
	}
	dir = await mkdtemp(join(tmpdir(), "ctx-agent-schedules-"))
	await worker.update({
		workers: [
			{
				configPath: new URL("./wrangler.jsonc", import.meta.url),
				env: "test",
				prebuiltWorkerDir: new URL("./build/server", import.meta.url),
				secrets: env,
			},
			{
				configPath: new URL("../build/wrangler.jsonc", import.meta.url),
				env: "test",
			},
		],
	})
	origin = (await worker.listen()).url.origin
})

afterAll(async () => {
	try {
		const { ARTIFACTS, FOLDERS } = await worker
			.getWorker<PlatformEnv["Bindings"]>()
			.getEnv()
		for (const name of folderNames) await FOLDERS.delete(name)
		for (const id of appIds) await ARTIFACTS.delete(id)
	} finally {
		await worker.close()
		if (dir) await rm(dir, { force: true, recursive: true })
		await db?.destroy()
		await databases?.dropAll()
	}
})

test("members' published cron jobs use viewer resources and retain results after Worker reload", async () => {
	const post = (body: unknown) => ({
		body: JSON.stringify(body),
		headers: { ...headers, "content-type": "application/json" },
		method: "POST",
	})
	const identity = await fetch(new URL("/api/me", env.CTX_AUTH_ISSUER), { headers })
	expect(identity.status).toBe(200)
	const user = z.object({ id: z.string().min(1) }).parse(await identity.json())
	const organizationSlug = z.string().min(1).parse(process.env.CTX_TEST_ORGANIZATION_SLUG)
	const organizationId = z.string().min(1).parse(process.env.CTX_TEST_ORGANIZATION_ID)
	const apps = []
	for (let index = 0; index < 2; index++) {
		const response = await fetch(
			`${origin}/api/apps`,
			post({ organization_slug: organizationSlug }),
		)
		expect(response.status).toBe(201)
		const app = appSchema.parse(await response.json())
		appIds.push(app.id)
		apps.push(app)
		expect(app.owner_organization_id).toBe(organizationId)
		expect(
			await db
				.selectFrom("app_member")
				.selectAll()
				.where("app_id", "=", app.id)
				.execute(),
		).toEqual([{ app_id: app.id, user_id: user.id }])
	}
	const [joinedBeforePublication, joinedAfterPublication] = apps
	if (!joinedBeforePublication || !joinedAfterPublication)
		throw new Error("Expected scheduled test apps")
	await db
		.deleteFrom("app_member")
		.where("app_id", "=", joinedAfterPublication.id)
		.execute()
	const accounts = await fetch(`${origin}/api/connections?toolkit=gmail`, { headers })
	expect(accounts.status).toBe(200)
	const account = connectionsSchema.parse(await accounts.json()).connections[0]
	if (!account) throw new Error("Expected the existing active personal Gmail account")
	const { AGENTS } = await worker.getWorker<PlatformEnv["Bindings"]>().getEnv()
	const { PUBLICATION } = await worker
		.getWorker<{ PUBLICATION: Service<Publication> }>("contextlayer-build-test")
		.getEnv()
	const cli = join(import.meta.dirname, "../cli/dist/cli.mjs")
	const gitEnv = {
		...process.env,
		CTX_AUTH_ISSUER: env.CTX_AUTH_ISSUER,
		CTX_PLATFORM_URL: origin,
		GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
		GIT_TERMINAL_PROMPT: "0",
	}
	await execFile(
		"git",
		["config", "--global", `credential.${origin}/git.helper`, `${cli} git-credential`],
		{ cwd: dir, env: gitEnv },
	)
	const projects = []
	for (const [index, app] of apps.entries()) {
		const project = join(dir, app.id)
		await mkdir(join(project, "agents/daily-summary/schedules"), { recursive: true })
		await mkdir(join(project, "public"))
		const git = async (...args: string[]) =>
			(await execFile("git", args, { cwd: project, env: gitEnv })).stdout.trim()
		await git("init", "-b", "main")
		await git("config", "user.name", "Scheduled Agent Test")
		await git("config", "user.email", "agent-test@example.com")
		await git("remote", "add", "origin", `${origin}/git/${app.id}`)
		await writeFile(
			join(project, "public/slate.json"),
			JSON.stringify({
				connections: { mail: { mode: "viewer", toolkit: "gmail" } },
				folders: { reports: { mode: "owner" } },
			}),
		)
		await writeFile(
			join(project, "agents/daily-summary/slate.json"),
			JSON.stringify({
				connections: { mail: { mode: "viewer", toolkit: "gmail" } },
				folders: { inbox: { mode: "viewer" }, reports: { mode: "owner" } },
				secrets: { ANTHROPIC_API_KEY: { mode: index === 0 ? "owner" : "viewer" } },
			}),
		)
		await writeFile(
			join(project, "agents/daily-summary/instructions.md"),
			"Use only read-only operations. Never send messages, create, update or delete account data. Do not read email messages or disclose credentials or account details.\n",
		)
		const scheduleFile = join(project, "agents/daily-summary/schedules/profile.md")
		await writeFile(
			scheduleFile,
			'---\ncron: "0 0 1 1 *"\n---\nInspect only mailbox profile metadata with a read-only Gmail tool. Report only whether it succeeded.\n',
		)
		await git("add", "public", "agents")
		await git("-c", "commit.gpgsign=false", "commit", "-m", "Publish scheduled agent")
		await git("push", "origin", "main")
		expect(
			(
				await fetch(
					`${origin}/api/apps/${app.id}/connections/assign`,
					post({ connection_id: account.id, slug: "mail" }),
				)
			).status,
		).toBe(200)
		const inventory = await fetch(`${origin}/api/apps/${app.id}/resources/list`, post({}))
		expect(inventory.status).toBe(200)
		const { resources } = appResourcesSchema.parse(await inventory.json())
		expect(resources.connections.mail?.owner).toEqual({ id: user.id, type: "user" })
		expect(resources.secrets.ANTHROPIC_API_KEY?.owner).toEqual(
			index === 0
				? { id: organizationId, type: "organization" }
				: { id: user.id, type: "user" },
		)
		for (const { repository_name } of Object.values(resources.folders))
			folderNames.add(repository_name)
		await PUBLICATION.publish(app.id)
		const memberInstance = await getAgentByName(
			AGENTS,
			getAgentInstanceName(app.id, "daily-summary", { id: user.id, type: "user" }),
		)
		const appInstance = await getAgentByName(
			AGENTS,
			getAgentInstanceName(app.id, "daily-summary", { type: "app" }),
		)
		expect(await appInstance.listSchedules()).toEqual([])
		expect(await memberInstance.listSchedules()).toHaveLength(index === 0 ? 1 : 0)
		projects.push({ app, folders: resources.folders, git, memberInstance, scheduleFile })
	}
	const joined = await fetch(`${origin}/api/apps/${joinedAfterPublication.id}/join`, {
		headers,
		method: "POST",
	})
	expect(joined.status).toBe(200)
	expect(await joined.json()).toEqual({
		app_id: joinedAfterPublication.id,
		user_id: user.id,
	})
	expect(await projects[1]?.memberInstance.listSchedules()).toHaveLength(1)
	const firing = new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 60_000)
	const cron = `${firing.getUTCMinutes()} ${firing.getUTCHours()} ${firing.getUTCDate()} ${firing.getUTCMonth() + 1} *`
	for (const { app, git, memberInstance, scheduleFile } of projects) {
		await writeFile(
			scheduleFile,
			`---\ncron: "${cron}"\n---\nInspect only mailbox profile metadata with a read-only Gmail tool. Save proof.txt containing the marker ${app.id} in both inbox and reports. Commit and push each folder to origin/main. Report only whether this refreshed scheduled task succeeded.\n`,
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
		await PUBLICATION.publish(app.id)
		const schedules = z
			.array(z.object({ payload: scheduledAgentRunSchema }))
			.parse(await memberInstance.listSchedules())
		expect(schedules).toHaveLength(1)
		expect(schedules[0]?.payload).toMatchObject({
			actor: { id: user.id, type: "user" },
			appId: app.id,
			prompt: expect.stringContaining("refreshed scheduled task"),
		})
	}
	const jobs = z.object({ jobs: z.array(agentJobSchema) })
	const saved: { url: string; job: AgentJob }[] = []
	for (const { app } of projects) {
		const url = `${origin}/api/apps/${app.id}/agents/daily-summary/jobs`
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
			app_id: app.id,
			id: completed?.id,
			source: completed?.source,
			status: completed?.status,
		})
		expect(completed?.error).toBeUndefined()
		expect(completed?.status).toBe("completed")
		expect(completed?.result?.length).toBeGreaterThan(0)
		if (!completed) throw new Error("Expected a completed scheduled job")
		expect(completed.instance_name).toBe(
			getAgentInstanceName(app.id, "daily-summary", { id: user.id, type: "user" }),
		)
		saved.push({ job: completed, url })
	}
	const apiUrl = `${origin}/api/apps/${joinedBeforePublication.id}/agents/daily-summary/jobs`
	const submitted = await fetch(
		apiUrl,
		post({
			prompt: `Save api-proof.txt containing the marker ${joinedBeforePublication.id} in both inbox and reports, commit and push each folder to origin/main. Report only whether the API task completed. Disclose no account details.`,
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
	await worker.update((current) => current)
	for (const { job, url } of saved) {
		const response = await fetch(detailUrl(url, job), { headers })
		expect(response.status).toBe(200)
		expect(agentJobSchema.parse(await response.json())).toEqual(job)
		const listed = await fetch(url, { headers })
		expect(listed.status).toBe(200)
		expect(jobs.parse(await listed.json()).jobs).toContainEqual(job)
	}
	const { FOLDERS } = await worker.getWorker<PlatformEnv["Bindings"]>().getEnv()
	for (const { app, folders } of projects) {
		for (const folder of Object.values(folders)) {
			const repo = await FOLDERS.get(folder.repository_name)
			const document = await repo.readFile({ path: "proof.txt", ref: "main" })
			expect(document).not.toBeNull()
			expect(await document?.text()).toContain(app.id)
			if (app.id === joinedBeforePublication.id) {
				const apiDocument = await repo.readFile({ path: "api-proof.txt", ref: "main" })
				expect(apiDocument).not.toBeNull()
				expect(await apiDocument?.text()).toContain(app.id)
			}
		}
	}
	console.info("Declared folder documents committed by scheduled and API jobs", {
		folders: folderNames.size,
	})
	console.info(
		"Agent jobs retained after Worker reload",
		saved.map(({ job }) => ({ id: job.id, source: job.source, status: job.status })),
	)
}, 480_000)
