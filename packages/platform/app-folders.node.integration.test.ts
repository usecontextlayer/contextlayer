import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import {
	type ProvisionedDatabases,
	provisionEphemeralDatabases,
} from "@usecontextlayer/db-infra/ephemeral"
import {
	type AppResourceConfiguration,
	appResourcesSchema,
} from "@usecontextlayer/shared/app-resources"
import { getAgentByName } from "agents/routing"
import { afterAll, beforeAll, expect, test } from "vitest"
import { createTestHarness } from "wrangler"
import { z } from "zod"
import { getAgentInstanceName } from "@/agent-instance"
import { scheduledAgentRunSchema } from "@/agents.schema"
import { type App, appSchema } from "@/apps.schema"
import type { PlatformEnv } from "@/context"
import { createPlatformDb } from "@/database"
import { migrateToLatest } from "@/database/migrate"
import { parsePlatformEnv } from "@/env"
import type { Publication } from "@/publication.server"

const execFile = promisify(execFileCallback)
const worker = createTestHarness()
const appIds: string[] = []
const folderNames = new Set<string>()
let databases: ProvisionedDatabases<"ctx_app_folders">
let db: ReturnType<typeof createPlatformDb>
let env: ReturnType<typeof parsePlatformEnv>
let dir: string
let origin: string
let headers: { authorization: string }

beforeAll(async () => {
	databases = await provisionEphemeralDatabases({
		migrators: { ctx_app_folders: migrateToLatest },
	})
	db = createPlatformDb(databases.urls.ctx_app_folders)
	env = parsePlatformEnv({
		...process.env,
		CTX_PLATFORM_DATABASE_URL: databases.urls.ctx_app_folders,
	})
	headers = {
		authorization: `Bearer ${z.string().min(1).parse(process.env.CTX_TEST_ACCESS_TOKEN)}`,
	}
	dir = await mkdtemp(join(tmpdir(), "ctx-app-folders-"))
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

test("join and publication provision only members' declared app and agent folders", async () => {
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
	const apps: App[] = []
	for (let index = 0; index < 2; index++) {
		const response = await fetch(
			`${origin}/api/apps`,
			post({ organization_slug: organizationSlug }),
		)
		expect(response.status).toBe(201)
		const app = appSchema.parse(await response.json())
		appIds.push(app.id)
		apps.push(app)
	}
	const [joinedBeforePublication, joinedAfterPublication] = apps
	if (!joinedBeforePublication || !joinedAfterPublication)
		throw new Error("Expected folder test apps")
	await db
		.deleteFrom("app_member")
		.where("app_id", "=", joinedAfterPublication.id)
		.execute()
	const { ARTIFACTS, FOLDERS, AGENTS } = await worker
		.getWorker<PlatformEnv["Bindings"]>()
		.getEnv()
	const { PUBLICATION } = await worker
		.getWorker<{ PUBLICATION: Service<Publication> }>("contextlayer-build-test")
		.getEnv()
	const gitEnv = {
		...process.env,
		CTX_AUTH_ISSUER: env.CTX_AUTH_ISSUER,
		CTX_PLATFORM_URL: origin,
		GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
		GIT_TERMINAL_PROMPT: "0",
	}
	const cli = join(import.meta.dirname, "../cli/dist/cli.mjs")
	await execFile(
		"git",
		["config", "--global", `credential.${origin}/git.helper`, `${cli} git-credential`],
		{
			cwd: dir,
			env: gitEnv,
		},
	)
	const listRepositories = async (artifacts: Artifacts) => {
		const repositories = new Map<string, Omit<ArtifactsRepoInfo, "remote">>()
		let cursor: string | undefined
		do {
			const page = await artifacts.list({ cursor, limit: 200 })
			for (const repo of page.repos) repositories.set(repo.name, repo)
			cursor = page.cursor
		} while (cursor)
		return repositories
	}
	const projects = []
	const readConfiguration = async (app: App) => {
		const response = await fetch(`${origin}/api/apps/${app.id}/resources/list`, post({}))
		expect(response.status).toBe(200)
		const { resources } = appResourcesSchema.parse(await response.json())
		for (const { repository_name } of Object.values(resources.folders))
			folderNames.add(repository_name)
		return resources
	}
	const joinMember = async (app: App) => {
		const response = await fetch(`${origin}/api/apps/${app.id}/join`, {
			headers,
			method: "POST",
		})
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ app_id: app.id, user_id: user.id })
	}
	await joinMember(joinedBeforePublication)
	for (const app of apps) {
		const project = join(dir, app.id)
		await mkdir(join(project, "agents/daily-summary/schedules"), { recursive: true })
		await mkdir(join(project, "public"))
		const git = async (...args: string[]) =>
			(await execFile("git", args, { cwd: project, env: gitEnv })).stdout.trim()
		await git("init", "-b", "main")
		await git("config", "user.name", "Folder Test")
		await git("config", "user.email", "folder-test@example.com")
		await git("remote", "add", "origin", `${origin}/git/${app.id}`)
		await writeFile(
			join(project, "public/slate.json"),
			JSON.stringify({
				connections: {},
				folders: { drafts: { mode: "viewer" }, reports: { mode: "owner" } },
			}),
		)
		await writeFile(
			join(project, "agents/daily-summary/slate.json"),
			JSON.stringify({
				connections: {},
				folders: { inbox: { mode: "viewer" }, reports: { mode: "owner" } },
			}),
		)
		await writeFile(
			join(project, "agents/daily-summary/instructions.md"),
			"Save scheduled documents in declared folders.\n",
		)
		const scheduleFile = join(project, "agents/daily-summary/schedules/documents.md")
		await writeFile(
			scheduleFile,
			'---\ncron: "0 0 1 1 *"\n---\nSave a scheduled document.\n',
		)
		await git("add", "public", "agents")
		await git(
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-m",
			"Declare app and agent folders",
		)
		await git("push", "origin", "main")
		const configuration = await readConfiguration(app)
		expect(Object.keys(configuration.folders).sort()).toEqual([
			"drafts",
			"inbox",
			"reports",
		])
		expect(configuration.folders.reports).toMatchObject({
			consumers: [{ type: "app" }, { name: "daily-summary", type: "agent" }],
			owner: { id: organizationId, type: "organization" },
		})
		for (const slug of ["drafts", "inbox"])
			expect(configuration.folders[slug]?.owner).toEqual({ id: user.id, type: "user" })
		const unpublishedFolders = await listRepositories(FOLDERS)
		for (const { repository_name } of Object.values(configuration.folders))
			expect(unpublishedFolders.has(repository_name)).toBe(false)
		await PUBLICATION.publish(app.id)
		const instance = await getAgentByName(
			AGENTS,
			getAgentInstanceName(app.id, "daily-summary", { id: user.id, type: "user" }),
		)
		expect(await instance.listSchedules()).toHaveLength(
			app.id === joinedBeforePublication.id ? 1 : 0,
		)
		projects.push({ app, configuration, git, instance, project, scheduleFile })
	}
	const existing = new Map<string, string>()
	const publishedFolders = await listRepositories(FOLDERS)
	const sourceRepositories = await listRepositories(ARTIFACTS)
	for (const { app, configuration } of projects) {
		for (const { repository_name } of Object.values(configuration.folders)) {
			if (app.id === joinedAfterPublication.id) {
				expect(publishedFolders.has(repository_name)).toBe(false)
			} else {
				const info = publishedFolders.get(repository_name)
				if (!info) throw new Error("Expected provisioned folder")
				expect(info.defaultBranch).toBe("main")
				existing.set(repository_name, info.id)
				expect(sourceRepositories.has(repository_name)).toBe(false)
			}
		}
	}
	await joinMember(joinedAfterPublication)
	const joinedFolders = await listRepositories(FOLDERS)
	for (const { configuration, instance } of projects) {
		expect(await instance.listSchedules()).toHaveLength(1)
		for (const { repository_name } of Object.values(configuration.folders)) {
			const info = joinedFolders.get(repository_name)
			if (!info) throw new Error("Expected joined member's folder")
			existing.set(repository_name, info.id)
		}
	}
	for (const slug of ["drafts", "inbox", "reports"])
		expect(projects[0]?.configuration.folders[slug]?.repository_name).not.toBe(
			projects[1]?.configuration.folders[slug]?.repository_name,
		)
	for (const { app, project, git, scheduleFile, instance } of projects) {
		await joinMember(app)
		await writeFile(
			join(project, "public/slate.json"),
			JSON.stringify({
				connections: {},
				folders: {
					archive: { mode: "owner" },
					drafts: { mode: "viewer" },
					reports: { mode: "owner" },
				},
			}),
		)
		await writeFile(
			scheduleFile,
			'---\ncron: "0 1 1 1 *"\n---\nSave a refreshed scheduled document.\n',
		)
		await git("add", "public", "agents")
		await git(
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-m",
			"Add a folder and refresh the schedule",
		)
		await git("push", "origin", "main")
		const configuration: AppResourceConfiguration = await readConfiguration(app)
		const archive = configuration.folders.archive
		if (!archive) throw new Error("Expected new archive declaration")
		expect((await listRepositories(FOLDERS)).has(archive.repository_name)).toBe(false)
		await PUBLICATION.publish(app.id)
		expect(
			(await listRepositories(FOLDERS)).get(archive.repository_name)?.defaultBranch,
		).toBe("main")
		const schedules = z
			.array(z.object({ payload: scheduledAgentRunSchema }))
			.parse(await instance.listSchedules())
		expect(schedules).toHaveLength(1)
		expect(schedules[0]?.payload.prompt).toContain("refreshed scheduled document")
		await PUBLICATION.publish(app.id)
	}
	const retainedFolders = await listRepositories(FOLDERS)
	for (const [name, id] of existing) expect(retainedFolders.get(name)?.id).toBe(id)
	console.info("Declared folders provisioned through membership setup", {
		apps: appIds.length,
		folders: folderNames.size,
	})
}, 120_000)
