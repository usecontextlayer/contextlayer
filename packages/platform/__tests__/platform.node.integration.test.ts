import { execFile as execFileCallback } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { test } from "@tests/integration"
import { expect } from "vitest"
import { z } from "zod"
import { agentSchema } from "@/agents.schema"
import { appSchema, listedAppSchema } from "@/apps.schema"

const execFile = promisify(execFileCallback)

test("app ownership protects viewing, joining, listing, and native Git source access", async ({
	cliEnv,
	db,
	directory: dir,
	identity,
	organization,
	platform,
}) => {
	const { origin, worker } = platform
	const { headers, user } = identity
	const { ARTIFACTS } = await worker.getEnv()
	await using artifacts = new AsyncDisposableStack()
	const getApps = async () => {
		const response = await fetch(`${origin}/api/apps`, { headers })
		expect(response.status).toBe(200)
		return z.object({ apps: z.array(listedAppSchema) }).parse(await response.json())
	}
	expect((await fetch(`${origin}/api/apps`, { method: "POST" })).status).toBe(401)
	expect((await fetch(`${origin}/api/apps`)).status).toBe(401)
	expect((await fetch(`${origin}/dashboard/personal/apps`)).status).toBe(401)
	const created = await fetch(`${origin}/api/apps`, { headers, method: "POST" })
	expect(created.status).toBe(201)
	const app = appSchema.parse(await created.json())
	const appId = app.id
	artifacts.defer(async () => {
		await ARTIFACTS.delete(appId)
	})
	expect(app.owner_user_id).toBe(user.id)
	expect(app.owner_organization_id).toBeNull()
	expect(app.visibility).toBe("private")
	const member = { app_id: app.id, user_id: user.id }
	expect(
		await db.selectFrom("app_member").selectAll().where("app_id", "=", app.id).execute(),
	).toEqual([member])
	const organizationCreated = await fetch(`${origin}/api/apps`, {
		body: JSON.stringify({
			organization_slug: organization.slug,
		}),
		headers: { ...headers, "content-type": "application/json" },
		method: "POST",
	})
	expect(organizationCreated.status).toBe(201)
	const organizationApp = appSchema.parse(await organizationCreated.json())
	artifacts.defer(async () => {
		await ARTIFACTS.delete(organizationApp.id)
	})
	expect(organizationApp.owner_user_id).toBeNull()
	expect(organizationApp.owner_organization_id).not.toBeNull()
	expect(
		await db
			.selectFrom("app_member")
			.selectAll()
			.where("app_id", "=", organizationApp.id)
			.execute(),
	).toEqual([{ app_id: organizationApp.id, user_id: user.id }])
	const organizationJoin = await fetch(`${origin}/api/apps/${organizationApp.id}/join`, {
		headers,
		method: "POST",
	})
	expect(organizationJoin.status).toBe(200)
	expect(await organizationJoin.json()).toEqual({
		app_id: organizationApp.id,
		user_id: user.id,
	})
	const joinUrl = `${origin}/api/apps/${app.id}/join`
	expect((await fetch(joinUrl, { method: "POST" })).status).toBe(401)
	await db.deleteFrom("app_member").where("app_id", "=", app.id).execute()
	const joined = await fetch(joinUrl, { headers, method: "POST" })
	expect(joined.status).toBe(200)
	expect(await joined.json()).toEqual(member)
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
		(
			await fetch(visibilityUrl, {
				...visibilityRequest,
				headers: { "content-type": "application/json" },
			})
		).status,
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
		expect((await fetch(joinUrl, { headers, method: "POST" })).status).toBe(
			visibility === "public" ? 403 : 200,
		)
	}
	expect((await fetch(refs)).status).toBe(401)
	expect((await fetch(refs)).headers.get("WWW-Authenticate")).toContain("Bearer")
	const connectionList = `${origin}/api/apps/${app.id}/connections/list`
	const agentUrl = `${origin}/api/apps/${app.id}/agents/company-brief`
	expect((await fetch(agentUrl)).status).toBe(401)
	expect((await fetch(agentUrl, { headers })).status).toBe(404)
	const listRequest = {
		body: JSON.stringify({}),
		headers: { ...headers, "content-type": "application/json" },
		method: "POST",
	}
	expect(
		(
			await fetch(connectionList, {
				...listRequest,
				body: JSON.stringify({
					resources: { connections: {}, folders: {}, secrets: {} },
				}),
			})
		).status,
	).toBe(400)
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
	for (const operation of ["connections/assign", "tools/call", "join"]) {
		expect(
			(
				await fetch(`${origin}/api/apps/${app.id}/${operation}`, {
					headers,
					method: "POST",
				})
			).status,
		).toBe(403)
	}
	expect((await getApps()).apps).toEqual([{ ...organizationApp, latest_commit: null }])
	await db
		.updateTable("app")
		.set({ visibility: "public" })
		.where("id", "=", app.id)
		.execute()
	expect((await fetch(resolveUrl)).status).toBe(200)
	expect((await fetch(joinUrl, { headers, method: "POST" })).status).toBe(403)
	expect((await fetch(agentUrl, { headers })).status).toBe(403)
	expect(
		(
			await fetch(visibilityUrl, {
				...visibilityRequest,
				body: JSON.stringify({ visibility: "private" }),
			})
		).status,
	).toBe(403)
	expect(
		await db
			.selectFrom("app")
			.select("visibility")
			.where("id", "=", app.id)
			.executeTakeFirstOrThrow(),
	).toEqual({ visibility: "public" })
	expect((await fetch(refs, { headers })).status).toBe(403)
	expect((await getApps()).apps).toEqual([{ ...organizationApp, latest_commit: null }])
	await db
		.updateTable("app")
		.set({ owner_user_id: user.id, visibility: "private" })
		.where("id", "=", app.id)
		.execute()
	const cli = join(import.meta.dirname, "../../cli/dist/cli.mjs")
	const gitEnv = {
		...process.env,
		...cliEnv,
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
	await git("remote", "add", "origin", gitUrl)
	await db.deleteFrom("app_member").where("app_id", "=", app.id).execute()
	for (const target of [app.id, app.public_hostname, "local"]) {
		const joined = await execFile(process.execPath, [cli, "join", target], {
			cwd: dir,
			env: {
				...process.env,
				...cliEnv,
			},
		})
		expect(JSON.parse(joined.stdout)).toEqual(member)
	}
	expect(
		await db.selectFrom("app_member").selectAll().where("app_id", "=", app.id).execute(),
	).toEqual([member])
	await git("config", "user.name", "Platform Test")
	await git("config", "user.email", "platform-test@example.com")
	await writeFile(join(dir, "README.md"), "# My app\n")
	await writeFile(join(dir, "hello.txt"), "Hello ContextLayer\n")
	const instructionsPath = join(dir, "agents/company-brief/instructions.md")
	let instructions = "You research companies and write concise briefs.\n"
	await mkdir(join(dir, "agents/company-brief"), { recursive: true })
	await writeFile(instructionsPath, instructions)
	await mkdir(join(dir, "public"))
	await writeFile(
		join(dir, "public/slate.json"),
		JSON.stringify({
			connections: {},
			secrets: { CLAUDE_CODE_OAUTH_TOKEN: { mode: "owner" } },
		}),
	)
	await writeFile(
		join(dir, "agents/company-brief/slate.json"),
		JSON.stringify({
			connections: {},
			secrets: { CLAUDE_CODE_OAUTH_TOKEN: { mode: "owner" } },
		}),
	)
	await git("add", "README.md", "hello.txt", "agents", "public/slate.json")
	await git("-c", "commit.gpgsign=false", "commit", "-m", "First app")
	const revision = await git("rev-parse", "HEAD")
	await git("push", `${origin}/git/${appId}`, "main")
	const agent = await fetch(agentUrl, { headers })
	expect(agent.status).toBe(200)
	const publishedAgent = agentSchema.parse(await agent.json())
	expect(publishedAgent).toEqual({
		commit: revision,
		instructions,
	})
	expect((await getApps()).apps).toContainEqual({ ...app, latest_commit: revision })
	expect((await fetch(connectionList, listRequest)).status).toBe(200)
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
				"/apps/{target}/join": z.object({
					post: z.object({ operationId: z.string() }),
				}),
			}),
		})
		.parse(await (await fetch(`${origin}/api/openapi.json`)).json())
	expect(schema.paths["/apps"].get.operationId).toBe("listApps")
	expect(schema.paths["/apps/{target}/agents/{name}"].get.operationId).toBe("getAgent")
	expect(schema.paths["/apps/{target}/join"].post.operationId).toBe("joinApp")
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
})
