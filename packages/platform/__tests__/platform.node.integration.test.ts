import { execFile as execFileCallback } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { test } from "@tests/integration"
import { expect } from "vitest"
import { z } from "zod"
import { agentSchema } from "@/agents.schema"
import { listedSlateSchema, slateSchema } from "@/slates.schema"

const execFile = promisify(execFileCallback)

test("slate ownership protects viewing, listing, and native Git source access", async ({
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
	const getSlates = async () => {
		const response = await fetch(`${origin}/api/slates`, { headers })
		expect(response.status).toBe(200)
		return z.object({ slates: z.array(listedSlateSchema) }).parse(await response.json())
	}
	expect((await fetch(`${origin}/api/slates`, { method: "POST" })).status).toBe(401)
	expect((await fetch(`${origin}/api/slates`)).status).toBe(401)
	expect((await fetch(`${origin}/dashboard/personal/slates`)).status).toBe(401)
	const created = await fetch(`${origin}/api/slates`, { headers, method: "POST" })
	expect(created.status).toBe(201)
	const slate = slateSchema.parse(await created.json())
	const slateId = slate.id
	artifacts.defer(async () => {
		await ARTIFACTS.delete(slateId)
	})
	expect(slate.owner_user_id).toBe(user.id)
	expect(slate.owner_organization_id).toBeNull()
	expect(slate.visibility).toBe("private")
	expect(
		await db
			.selectFrom("slate_member")
			.selectAll()
			.where("slate_id", "=", slate.id)
			.execute(),
	).toEqual([])
	const organizationCreated = await fetch(`${origin}/api/slates`, {
		body: JSON.stringify({
			organization_slug: organization.slug,
		}),
		headers: { ...headers, "content-type": "application/json" },
		method: "POST",
	})
	expect(organizationCreated.status).toBe(201)
	const organizationSlate = slateSchema.parse(await organizationCreated.json())
	artifacts.defer(async () => {
		await ARTIFACTS.delete(organizationSlate.id)
	})
	expect(organizationSlate.owner_user_id).toBeNull()
	expect(organizationSlate.owner_organization_id).not.toBeNull()
	expect(
		await db
			.selectFrom("slate_member")
			.selectAll()
			.where("slate_id", "=", organizationSlate.id)
			.execute(),
	).toEqual([])
	expect(slate.id).toMatch(/^[0-9a-f-]{36}$/)
	expect(slate.public_hostname).toMatch(/^[a-z-]+\.contextlayer\.xyz$/)
	expect((await getSlates()).slates).toContainEqual({ ...slate, latest_commit: null })
	const gitUrl = `${origin}/git/${slateId}`
	const refs = `${gitUrl}/info/refs?service=git-upload-pack`
	const resolveUrl = new URL(`${origin}/api/slates/resolve`)
	resolveUrl.searchParams.set("hostname", slate.public_hostname)
	resolveUrl.searchParams.set("pathname", "/slate.json")
	expect((await fetch(resolveUrl)).status).toBe(401)
	expect((await fetch(resolveUrl, { headers })).status).toBe(200)
	const visibilityUrl = `${origin}/api/slates/${slate.id}`
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
		expect(await updated.json()).toEqual({ ...slate, visibility })
		expect(
			await db
				.selectFrom("slate")
				.select("visibility")
				.where("id", "=", slate.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ visibility })
		expect((await fetch(resolveUrl)).status).toBe(visibility === "public" ? 200 : 401)
	}
	expect((await fetch(refs)).status).toBe(401)
	expect((await fetch(refs)).headers.get("WWW-Authenticate")).toContain("Bearer")
	const connectionList = `${origin}/api/slates/${slate.id}/connections/list`
	const agentUrl = `${origin}/api/slates/${slate.id}/agents/company-brief`
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
					resources: { connections: {}, databases: {}, secrets: {} },
				}),
			})
		).status,
	).toBe(400)
	const otherOwner = "different-user"
	await db
		.updateTable("slate")
		.set({ owner_user_id: otherOwner })
		.where("id", "=", slate.id)
		.execute()
	expect((await fetch(resolveUrl, { headers })).status).toBe(403)
	expect((await fetch(refs, { headers })).status).toBe(403)
	expect((await fetch(visibilityUrl, visibilityRequest)).status).toBe(403)
	expect((await fetch(connectionList, listRequest)).status).toBe(403)
	expect((await fetch(agentUrl, { headers })).status).toBe(403)
	expect(
		(
			await fetch(`${origin}/api/slates/${slate.id}/connections/assign`, {
				headers,
				method: "POST",
			})
		).status,
	).toBe(403)
	expect((await getSlates()).slates).toEqual([
		{ ...organizationSlate, latest_commit: null },
	])
	await db
		.updateTable("slate")
		.set({ visibility: "public" })
		.where("id", "=", slate.id)
		.execute()
	expect((await fetch(resolveUrl)).status).toBe(200)
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
			.selectFrom("slate")
			.select("visibility")
			.where("id", "=", slate.id)
			.executeTakeFirstOrThrow(),
	).toEqual({ visibility: "public" })
	expect((await fetch(refs, { headers })).status).toBe(403)
	expect((await getSlates()).slates).toEqual([
		{ ...organizationSlate, latest_commit: null },
	])
	await db
		.updateTable("slate")
		.set({ owner_user_id: user.id, visibility: "private" })
		.where("id", "=", slate.id)
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
	await git("config", "user.name", "Platform Test")
	await git("config", "user.email", "platform-test@example.com")
	await writeFile(join(dir, "README.md"), "# My slate\n")
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
	await git("-c", "commit.gpgsign=false", "commit", "-m", "First slate")
	const revision = await git("rev-parse", "HEAD")
	await git("push", `${origin}/git/${slateId}`, "main")
	const agent = await fetch(agentUrl, { headers })
	expect(agent.status).toBe(200)
	const deployedAgent = agentSchema.parse(await agent.json())
	expect(deployedAgent).toEqual({
		commit: revision,
		instructions,
	})
	expect((await getSlates()).slates).toContainEqual({ ...slate, latest_commit: revision })
	expect((await fetch(connectionList, listRequest)).status).toBe(200)
	const entry = await fetch(`${origin}/dashboard`, { headers, redirect: "manual" })
	expect(entry.headers.get("Location")).toBe("/dashboard/personal/slates")
	const page = await fetch(`${origin}/dashboard/personal/slates`, { headers })
	expect(page.status).toBe(200)
	const html = await page.text()
	expect(html).toContain(slate.public_hostname)
	expect(html).toMatch(new RegExp(`<code\\b[^>]*>${revision.slice(0, 7)}</code>`))
	const schema = z
		.object({
			paths: z.object({
				"/slates": z.object({ get: z.object({ operationId: z.string() }) }),
				"/slates/{target}/agents/{name}": z.object({
					get: z.object({ operationId: z.string() }),
				}),
				"/slates/{target}/join": z.object({
					post: z.object({ operationId: z.string() }),
				}),
			}),
		})
		.parse(await (await fetch(`${origin}/api/openapi.json`)).json())
	expect(schema.paths["/slates"].get.operationId).toBe("listSlates")
	expect(schema.paths["/slates/{target}/agents/{name}"].get.operationId).toBe("getAgent")
	await git("clone", "--branch", "main", `${origin}/git/${slateId}`, "cloned")
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
	expect(await readFile(join(dir, "cloned", "README.md"), "utf8")).toBe("# My slate\n")
	await writeFile(join(dir, "hello.txt"), "Updated ContextLayer\n")
	instructions = "You research companies and write concise briefs with sources.\n"
	await writeFile(instructionsPath, instructions)
	await git("add", "hello.txt", "agents")
	await git("-c", "commit.gpgsign=false", "commit", "-m", "Update slate")
	await git("push", `${origin}/git/${slateId}`, "main")
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
