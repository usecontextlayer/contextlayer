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
import { migrateToLatest } from "@/database/migrate"
import { parsePlatformEnv } from "@/env"

const execFile = promisify(execFileCallback)

test("created app has a stable Git remote, repository, and dashboard entry", async () => {
	const databases = await provisionEphemeralDatabases({
		migrators: { ctx_platform_test: migrateToLatest },
	})
	const env = parsePlatformEnv({
		...process.env,
		CTX_PLATFORM_DATABASE_URL: databases.urls.ctx_platform_test,
	})
	const cloudflare = z
		.object({
			CLOUDFLARE_ACCOUNT_ID: z.string().min(1),
			CLOUDFLARE_API_TOKEN: z.string().min(1),
		})
		.parse(process.env)
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
		const getApps = async () => {
			const response = await fetch(`${origin}/api/apps`)
			expect(response.status).toBe(200)
			return z.object({ apps: z.array(listedAppSchema) }).parse(await response.json())
		}
		const created = await fetch(`${origin}/api/apps`, { method: "POST" })
		expect(created.status).toBe(201)
		const app = appSchema.parse(await created.json())
		appId = app.id
		expect(app.id).toMatch(/^[0-9a-f-]{36}$/)
		expect(app.public_hostname).toMatch(/^[a-z-]+\.contextlayer\.xyz$/)
		expect((await getApps()).apps).toContainEqual({ ...app, latest_commit: null })
		const git = async (...args: string[]) =>
			(await execFile("git", args, { cwd: dir })).stdout.trim()
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
		const page = await fetch(`${origin}/dashboard/apps`)
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
				await execFile("git", ["rev-parse", "HEAD"], { cwd: join(dir, "cloned") })
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
		await execFile("git", ["pull", "--ff-only"], { cwd: join(dir, "cloned") })
		expect(await readFile(join(dir, "cloned", "hello.txt"), "utf8")).toBe(
			"Updated ContextLayer\n",
		)
	} finally {
		server.kill("SIGTERM")
		await exited
		await rm(dir, { force: true, recursive: true })
		await databases.dropAll()
		if (appId) {
			const deleted = await fetch(
				`https://api.cloudflare.com/client/v4/accounts/${cloudflare.CLOUDFLARE_ACCOUNT_ID}/artifacts/namespaces/${namespace}/repos/${appId}`,
				{
					headers: { authorization: `Bearer ${cloudflare.CLOUDFLARE_API_TOKEN}` },
					method: "DELETE",
				},
			)
			expect(deleted.ok).toBe(true)
		}
	}
})
