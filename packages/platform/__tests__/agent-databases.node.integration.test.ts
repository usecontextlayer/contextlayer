import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { ToolResultEntry } from "@earendil-works/pi-durable"
import { writeDatabase, writeDatabaseProject } from "@tests/database-project"
import { provisioningTest as test } from "@tests/integration"
import { DEVELOPMENT_ORGANIZATION_SLUG } from "@usecontextlayer/dev-env/env"
import { signInViewer } from "@usecontextlayer/dev-env/viewer"
import { type Databases, databaseResultSchema } from "@usecontextlayer/shared/databases"
import { slateResourcesSchema } from "@usecontextlayer/shared/slate-resources"
import { expect } from "vitest"
import { z } from "zod"
import {
	agentJobCreationSchema,
	agentJobMessageSchema,
	agentJobResultSchema,
} from "@/agents.schema"
import { organizationSchema } from "@/auth.server"
import { slateSchema } from "@/slates.schema"

const execFile = promisify(execFileCallback)

for (const [mode, tool] of [
	["owner", "database_query"],
	["viewer", "codemode"],
] as const) {
	test(`API jobs persist writes to the ${mode} database through ${tool}`, async ({
		directory,
		execution,
		platform,
		provisioning,
		serviceEnv,
		webEnv,
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
		const organizationsResponse = await fetch(
			`${webEnv.BETTER_AUTH_URL}/api/platform/organizations`,
			{ headers: webSession.headers },
		)
		expect(organizationsResponse.status).toBe(200)
		const organization = z
			.object({ organizations: z.array(organizationSchema) })
			.parse(await organizationsResponse.json())
			.organizations.find((item) => item.slug === DEVELOPMENT_ORGANIZATION_SLUG)
		assert(organization, "Initialize the local development organization")
		const created = await fetch(
			`${origin}/api/slates`,
			post({ organization_slug: organization.slug }),
		)
		expect(created.status).toBe(201)
		const slate = slateSchema.parse(await created.json())
		const { ARTIFACTS } = await worker.getEnv()
		await using resources = new AsyncDisposableStack()
		resources.defer(async () => {
			await ARTIFACTS.delete(slate.id)
		})
		const repo = await ARTIFACTS.get(slate.id)
		const { remote } = await repo.info()
		const token = await repo.createToken("write")
		const slug = mode === "owner" ? "reports" : "drafts"
		await mkdir(join(directory, "agents/database"), { recursive: true })
		await mkdir(join(directory, "public"))
		await writeFile(
			join(directory, "public/slate.json"),
			JSON.stringify({
				connections: {},
				databases: { drafts: { mode: "viewer" }, reports: { mode: "owner" } },
			}),
		)
		await writeFile(
			join(directory, "agents/database/slate.json"),
			JSON.stringify({
				connections: {},
				databases: { [slug]: { mode } },
				secrets: { ANTHROPIC_API_KEY: { mode: "owner" } },
			}),
		)
		await writeFile(
			join(directory, "agents/database/instructions.md"),
			"Use the requested database tool. These are disposable acceptance databases; the requested SQL writes are authorized. Do not use Bash. Report completion briefly.\n",
		)
		await writeDatabaseProject(directory)
		for (const database of ["drafts", "reports"]) await writeDatabase(directory, database)
		const sql =
			"INSERT INTO updates (id, kind, body, created_at) SELECT ?, kind, body, ? FROM updates WHERE id = ? RETURNING id, body"
		const copy = { params: ["copy", 2, "seed"], slug, sql }
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
		await git("config", "user.name", "Pi Database Acceptance")
		await git("config", "user.email", "pi-database-test@example.com")
		await git("add", ".")
		await git("-c", "commit.gpgsign=false", "commit", "-m", "Declare agent databases")
		await git("push", remote, "main")
		const { PROVISIONING } = await provisioning.worker.getEnv()
		const prepared = await PROVISIONING.prepare(
			slate.id,
			(await git("rev-parse", "HEAD")).stdout.trim(),
		)
		await PROVISIONING.migrate(prepared)
		await PROVISIONING.provisionSchedules(prepared)
		const viewerHeaders = await signInViewer({
			authURL: serviceEnv.addresses.CTX_VIEWER_AUTH_URL.origin,
			returnTo: `https://${slate.public_hostname}/`,
			webHeaders: webSession.headers,
		})
		const viewerToken = decodeURIComponent(
			new Headers(viewerHeaders).get("cookie")?.match(/ctx-viewer-auth=([^;]+)/)?.[1] ??
				"",
		)
		assert(viewerToken)
		const props = {
			credential: { token: viewerToken, type: "session" },
			slateId: slate.id,
		} as const
		const query = async (...args: Parameters<Databases["query"]>) => {
			const response = await execution.worker.fetch("http://execution/databases", {
				body: JSON.stringify([props, args]),
				headers: { "content-type": "application/json" },
				method: "POST",
			})
			expect(response.status).toBe(200)
			return databaseResultSchema.parse(await response.json())
		}
		const markers = {
			drafts: `personal-${webSession.user.id}`,
			reports: `org-${organization.id}`,
		}
		for (const database of ["drafts", "reports"] as const) {
			await query(
				database,
				"INSERT INTO updates (id, kind, body, created_at) VALUES (?, ?, ?, ?)",
				["seed", "proof", markers[database], 1],
			)
		}
		const inventory = await fetch(
			`${origin}/api/slates/${slate.id}/resources/list`,
			post({}),
		)
		expect(inventory.status).toBe(200)
		const { databases } = slateResourcesSchema.parse(await inventory.json()).resources
		expect(databases.reports?.owner).toEqual({
			id: organization.id,
			type: "organization",
		})
		expect(databases.drafts?.owner).toEqual({ id: webSession.user.id, type: "personal" })
		expect(databases.reports?.instance_name).not.toBe(databases.drafts?.instance_name)
		const url = `${origin}/api/slates/${slate.id}/agents/database/jobs`
		const submitted = await fetch(
			url,
			post({
				prompt:
					tool === "database_query"
						? `Copy the seed row using database_query with ${JSON.stringify(copy)}.`
						: `Copy the seed row using Code Mode to call tools.database_query with ${JSON.stringify(copy)}.`,
			}),
		)
		expect(submitted.status).toBe(202)
		const api = agentJobCreationSchema.parse(await submitted.json())
		const completed = await fetch(`${url}/${api.job.id}/result`, { headers })
		expect(completed.status).toBe(200)
		const result = agentJobResultSchema.parse(await completed.json())
		expect(result.status, result.reason).toBe("done")
		const messagesResponse = await fetch(
			`${url}/${api.job.id}/sessions/${result.session}/messages`,
			{ headers },
		)
		expect(messagesResponse.status).toBe(200)
		const messages = z.array(agentJobMessageSchema).parse(await messagesResponse.json())
		const toolResults = messages
			.filter((entry) => entry.kind === ToolResultEntry.kind)
			.flatMap((entry) => entry.model ?? [])
			.filter((message) => message.role === "toolResult" && message.toolName === tool)
		if (tool === "codemode") {
			expect(toolResults).toContainEqual(
				expect.objectContaining({
					details: expect.objectContaining({
						calls: expect.arrayContaining([
							expect.objectContaining({ name: "database_query", status: "ok" }),
						]),
					}),
					isError: false,
				}),
			)
		} else {
			expect(toolResults).toContainEqual(expect.objectContaining({ isError: false }))
		}
		const deleted = await fetch(`${url}/${api.job.id}`, { headers, method: "DELETE" })
		expect(deleted.status).toBe(204)
		for (const database of ["drafts", "reports"] as const) {
			const persisted = await query(
				database,
				"SELECT id, body FROM updates ORDER BY created_at",
			)
			expect(persisted.columns).toEqual(["id", "body"])
			expect(persisted.rows).toEqual(
				database === slug
					? [
							["seed", markers[database]],
							["copy", markers[database]],
						]
					: [["seed", markers[database]]],
			)
		}
	}, 360_000)
}
