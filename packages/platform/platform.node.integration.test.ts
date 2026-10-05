import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { provisionEphemeralDatabases } from "@usecontextlayer/db-infra/ephemeral"
import { expect, test } from "vitest"
import { z } from "zod"
import { agentSchema } from "@/agents.schema"
import { appSchema, listedAppSchema } from "@/apps.schema"
import { createPlatformDb } from "@/database"
import { migrateToLatest } from "@/database/migrate"
import { parsePlatformEnv } from "@/env"
import { startPlatformWorker } from "@/testing"

const execFile = promisify(execFileCallback)

test("app ownership protects viewing, listing, and native Git source access", async () => {
	const databases = await provisionEphemeralDatabases({
		migrators: { ctx_platform_test: migrateToLatest },
	})
	const env = parsePlatformEnv({
		...process.env,
		CTX_PLATFORM_DATABASE_URL: databases.urls.ctx_platform_test,
	})
	const accessToken = z.string().min(1).parse(process.env.CTX_TEST_ACCESS_TOKEN)
	const db = createPlatformDb(databases.urls.ctx_platform_test)
	const wranglerConfig = JSON.parse(
		await readFile(join(import.meta.dirname, "wrangler.jsonc"), "utf8"),
	)
	const namespace = z.string().parse(wranglerConfig.artifacts[0].namespace)
	let appId: string | undefined
	const dir = await mkdtemp(join(tmpdir(), "platform-story-"))
	const worker = await startPlatformWorker(env, {
		...process.env,
		WRANGLER_SEND_METRICS: "false",
	})
	try {
		const origin = await worker.ready
		const headers = { authorization: `Bearer ${accessToken}` }
		const getApps = async () => {
			const response = await fetch(`${origin}/api/apps`, { headers })
			expect(response.status).toBe(200)
			return z.object({ apps: z.array(listedAppSchema) }).parse(await response.json())
		}
		expect((await fetch(`${origin}/api/apps`, { method: "POST" })).status).toBe(401)
		expect((await fetch(`${origin}/api/apps`)).status).toBe(401)
		expect((await fetch(`${origin}/dashboard/personal/apps`)).status).toBe(401)
		const identity = await fetch(new URL("/api/me", env.CTX_AUTH_ISSUER), { headers })
		expect(identity.status).toBe(200)
		const user = z.object({ id: z.string().min(1) }).parse(await identity.json())
		const created = await fetch(`${origin}/api/apps`, { headers, method: "POST" })
		expect(created.status).toBe(201)
		const app = appSchema.parse(await created.json())
		appId = app.id
		expect(app.owner_user_id).toBe(user.id)
		expect(app.owner_organization_id).toBeNull()
		expect(app.visibility).toBe("private")
		expect(app.id).toMatch(/^[0-9a-f-]{36}$/)
		expect(app.public_hostname).toMatch(/^[a-z-]+\.contextlayer\.xyz$/)
		expect((await getApps()).apps).toContainEqual({ ...app, latest_commit: null })
		const gitUrl = `${origin}/git/${appId}`
		const refs = `${gitUrl}/info/refs?service=git-upload-pack`
		const resolveUrl = new URL(`${origin}/api/apps/resolve`)
		resolveUrl.searchParams.set("hostname", app.public_hostname)
		resolveUrl.searchParams.set("pathname", "/slate.json")
		expect((await fetch(resolveUrl)).status).toBe(401)
		expect((await fetch(resolveUrl, { headers })).status).toBe(200)
		const visibilityUrl = `${origin}/api/apps/${app.id}`
		const visibilityRequest = {
			body: JSON.stringify({ visibility: "public" }),
			headers: { ...headers, "content-type": "application/json" },
			method: "PATCH",
		}
		expect(
			(await fetch(visibilityUrl, { ...visibilityRequest, headers: {} })).status,
		).toBe(401)
		for (const visibility of ["public", "private"] as const) {
			const updated = await fetch(visibilityUrl, {
				...visibilityRequest,
				body: JSON.stringify({ visibility }),
			})
			expect(updated.status).toBe(200)
			expect(await updated.json()).toEqual({ ...app, visibility })
			expect(
				await db
					.selectFrom("app")
					.select("visibility")
					.where("id", "=", app.id)
					.executeTakeFirstOrThrow(),
			).toEqual({ visibility })
			expect((await fetch(resolveUrl)).status).toBe(visibility === "public" ? 200 : 401)
		}
		const dashboardUrl = `${origin}/dashboard/personal/apps`
		const dashboardRequest = {
			body: new URLSearchParams({ target: app.id, visibility: "public" }),
			headers,
			method: "POST",
		}
		for (const visibility of ["public", "private"] as const) {
			const updated = await fetch(dashboardUrl, {
				...dashboardRequest,
				body: new URLSearchParams({ target: app.id, visibility }),
			})
			expect(updated.status).toBe(200)
			expect(await updated.text()).toContain(`Visibility for ${app.public_hostname}`)
			expect((await getApps()).apps).toContainEqual({
				...app,
				latest_commit: null,
				visibility,
			})
			expect((await fetch(resolveUrl)).status).toBe(visibility === "public" ? 200 : 401)
		}
		expect((await fetch(refs)).status).toBe(401)
		expect((await fetch(refs)).headers.get("WWW-Authenticate")).toContain("Bearer")
		const connectionList = `${origin}/api/apps/${app.id}/connections/list`
		const agentUrl = `${origin}/api/apps/${app.id}/agents/company-brief`
		expect((await fetch(agentUrl)).status).toBe(401)
		expect((await fetch(agentUrl, { headers })).status).toBe(404)
		const listRequest = {
			body: JSON.stringify({ manifest: { connections: {} } }),
			headers: { ...headers, "content-type": "application/json" },
			method: "POST",
		}
		expect((await fetch(connectionList, listRequest)).status).toBe(200)
		const otherOwner = "different-user"
		await db
			.updateTable("app")
			.set({ owner_user_id: otherOwner })
			.where("id", "=", app.id)
			.execute()
		expect((await fetch(resolveUrl, { headers })).status).toBe(403)
		expect((await fetch(refs, { headers })).status).toBe(403)
		expect((await fetch(visibilityUrl, visibilityRequest)).status).toBe(403)
		expect((await fetch(connectionList, listRequest)).status).toBe(403)
		expect((await fetch(agentUrl, { headers })).status).toBe(403)
		for (const operation of ["connections/assign", "tools/call"]) {
			expect(
				(
					await fetch(`${origin}/api/apps/${app.id}/${operation}`, {
						headers,
						method: "POST",
					})
				).status,
			).toBe(403)
		}
		expect((await getApps()).apps).toEqual([])
		await db
			.updateTable("app")
			.set({ visibility: "public" })
			.where("id", "=", app.id)
			.execute()
		expect((await fetch(resolveUrl)).status).toBe(200)
		expect((await fetch(connectionList, listRequest)).status).toBe(200)
		expect((await fetch(agentUrl, { headers })).status).toBe(403)
		expect(
			(
				await fetch(visibilityUrl, {
					...visibilityRequest,
					body: JSON.stringify({ visibility: "private" }),
				})
			).status,
		).toBe(403)
		expect((await fetch(dashboardUrl, dashboardRequest)).status).toBe(403)
		expect(
			await db
				.selectFrom("app")
				.select("visibility")
				.where("id", "=", app.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ visibility: "public" })
		expect((await fetch(refs, { headers })).status).toBe(403)
		expect((await getApps()).apps).toEqual([])
		await db
			.updateTable("app")
			.set({ owner_user_id: user.id, visibility: "private" })
			.where("id", "=", app.id)
			.execute()
		const cli = join(import.meta.dirname, "../cli/dist/cli.mjs")
		const gitEnv = {
			...process.env,
			GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
			GIT_TERMINAL_PROMPT: "0",
		}
		const git = async (...args: string[]) =>
			(await execFile("git", args, { cwd: dir, env: gitEnv })).stdout.trim()
		await git(
			"config",
			"--global",
			`credential.${origin}/git.helper`,
			`${cli} git-credential`,
		)
		await git("init", "-b", "main")
		await git("config", "user.name", "Platform Test")
		await git("config", "user.email", "platform-test@example.com")
		await writeFile(join(dir, "README.md"), "# My app\n")
		await writeFile(join(dir, "hello.txt"), "Hello ContextLayer\n")
		const instructionsPath = join(dir, "agents/company-brief/instructions.md")
		let instructions = "You research companies and write concise briefs.\n"
		await mkdir(join(dir, "agents/company-brief"), { recursive: true })
		await writeFile(instructionsPath, instructions)
		await git("add", "README.md", "hello.txt", "agents")
		await git("-c", "commit.gpgsign=false", "commit", "-m", "First app")
		const revision = await git("rev-parse", "HEAD")
		await git("push", `${origin}/git/${appId}`, "main")
		const agent = await fetch(agentUrl, { headers })
		expect(agent.status).toBe(200)
		expect(agentSchema.parse(await agent.json())).toEqual({
			commit: revision,
			instructions,
		})
		expect((await getApps()).apps).toContainEqual({ ...app, latest_commit: revision })
		const page = await fetch(`${origin}/dashboard/personal/apps`, { headers })
		expect(page.status).toBe(200)
		const html = await page.text()
		expect(html).toContain(app.public_hostname)
		expect(html).toMatch(new RegExp(`<code\\b[^>]*>${revision.slice(0, 7)}</code>`))
		const schema = z
			.object({
				paths: z.object({
					"/apps": z.object({ get: z.object({ operationId: z.string() }) }),
					"/apps/{target}/agents/{name}": z.object({
						get: z.object({ operationId: z.string() }),
					}),
				}),
			})
			.parse(await (await fetch(`${origin}/api/openapi.json`)).json())
		expect(schema.paths["/apps"].get.operationId).toBe("listApps")
		expect(schema.paths["/apps/{target}/agents/{name}"].get.operationId).toBe("getAgent")
		await git("clone", "--branch", "main", `${origin}/git/${appId}`, "cloned")
		expect(
			(
				await execFile("git", ["rev-parse", "HEAD"], {
					cwd: join(dir, "cloned"),
					env: gitEnv,
				})
			).stdout.trim(),
		).toBe(revision)
		expect(await readFile(join(dir, "cloned", "hello.txt"), "utf8")).toBe(
			"Hello ContextLayer\n",
		)
		expect(await readFile(join(dir, "cloned", "README.md"), "utf8")).toBe("# My app\n")
		await writeFile(join(dir, "hello.txt"), "Updated ContextLayer\n")
		instructions = "You research companies and write concise briefs with sources.\n"
		await writeFile(instructionsPath, instructions)
		await git("add", "hello.txt", "agents")
		await git("-c", "commit.gpgsign=false", "commit", "-m", "Update app")
		await git("push", `${origin}/git/${appId}`, "main")
		const updatedAgent = await fetch(agentUrl, { headers })
		expect(updatedAgent.status).toBe(200)
		expect(agentSchema.parse(await updatedAgent.json())).toEqual({
			commit: await git("rev-parse", "HEAD"),
			instructions,
		})
		await execFile("git", ["pull", "--ff-only"], {
			cwd: join(dir, "cloned"),
			env: gitEnv,
		})
		expect(await readFile(join(dir, "cloned", "hello.txt"), "utf8")).toBe(
			"Updated ContextLayer\n",
		)
	} finally {
		worker.server.kill("SIGTERM")
		await worker.exited
		await rm(dir, { force: true, recursive: true })
		await db.destroy()
		await databases.dropAll()
		if (appId) {
			await execFile(
				process.execPath,
				[
					"node_modules/wrangler/bin/wrangler.js",
					"artifacts",
					"repos",
					"delete",
					appId,
					"--namespace",
					namespace,
					"--force",
				],
				{
					cwd: import.meta.dirname,
				},
			)
		}
	}
})
