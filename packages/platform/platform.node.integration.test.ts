import { execFile as execFileCallback, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { promisify } from "node:util"
import { provisionEphemeralDatabases } from "@usecontextlayer/db-infra/ephemeral"
import { expect, test } from "vitest"
import { z } from "zod"
import { appSchema, listedAppSchema } from "@/apps.schema"
import { createPlatformDb } from "@/database"
import { migrateToLatest } from "@/database/migrate"
import { parsePlatformEnv } from "@/env"

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
	const socket = createServer()
	socket.listen(0, "127.0.0.1")
	await once(socket, "listening")
	const address = socket.address()
	if (!address || typeof address === "string") throw new Error("Expected TCP address")
	const port = address.port
	await new Promise<void>((resolve) => socket.close(() => resolve()))
	const envFile = join(dir, ".env")
	await writeFile(
		envFile,
		Object.entries(env)
			.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
			.join("\n"),
		{ mode: 0o600 },
	)
	const server = spawn(
		process.execPath,
		[
			"node_modules/wrangler/bin/wrangler.js",
			"dev",
			"--config",
			"build/server/wrangler.json",
			"--env-file",
			envFile,
			"--ip",
			"127.0.0.1",
			"--port",
			String(port),
		],
		{
			cwd: import.meta.dirname,
			env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
			stdio: ["ignore", "pipe", "inherit"],
		},
	)
	server.stdout.on("data", (chunk) => process.stdout.write(chunk))
	const exited = once(server, "exit")
	try {
		let origin = ""
		for await (const line of createInterface({ input: server.stdout })) {
			const match = line.match(/http:\/\/127\.0\.0\.1:\d+/)
			if (match) {
				origin = match[0]
				break
			}
		}
		expect(origin).not.toBe("")
		const headers = { authorization: `Bearer ${accessToken}` }
		const getApps = async () => {
			const response = await fetch(`${origin}/api/apps`, { headers })
			expect(response.status).toBe(200)
			return z.object({ apps: z.array(listedAppSchema) }).parse(await response.json())
		}
		expect((await fetch(`${origin}/api/apps`, { method: "POST" })).status).toBe(401)
		expect((await fetch(`${origin}/api/apps`)).status).toBe(401)
		expect((await fetch(`${origin}/dashboard/personal/apps`)).status).toBe(401)
		const identity = await fetch(`${origin}/api/me`, { headers })
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
		expect((await fetch(resolveUrl)).status).toBe(401)
		expect((await fetch(resolveUrl, { headers })).status).toBe(200)
		expect((await fetch(refs)).status).toBe(401)
		expect((await fetch(refs)).headers.get("WWW-Authenticate")).toContain("Bearer")
		const connectionList = `${origin}/api/apps/${app.id}/connections/list`
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
		expect((await fetch(connectionList, listRequest)).status).toBe(403)
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
		await git("add", "README.md", "hello.txt")
		await git("-c", "commit.gpgsign=false", "commit", "-m", "First app")
		const revision = await git("rev-parse", "HEAD")
		await git("push", `${origin}/git/${appId}`, "main")
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
				}),
			})
			.parse(await (await fetch(`${origin}/api/openapi.json`)).json())
		expect(schema.paths["/apps"].get.operationId).toBe("listApps")
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
		await git("add", "hello.txt")
		await git("-c", "commit.gpgsign=false", "commit", "-m", "Update app")
		await git("push", `${origin}/git/${appId}`, "main")
		await execFile("git", ["pull", "--ff-only"], {
			cwd: join(dir, "cloned"),
			env: gitEnv,
		})
		expect(await readFile(join(dir, "cloned", "hello.txt"), "utf8")).toBe(
			"Updated ContextLayer\n",
		)
	} finally {
		server.kill("SIGTERM")
		await exited
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
