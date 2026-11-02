import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { ToolResultEntry } from "@earendil-works/pi-durable"
import { writeDatabase } from "@tests/database-project"
import { test } from "@tests/integration"
import seed from "@usecontextlayer/dev-env/seed.json" with { type: "json" }
import { copySlateProject } from "@usecontextlayer/dev-env/slate"
import { slateResourcesSchema } from "@usecontextlayer/shared/slate-resources"
import { expect } from "vitest"
import { z } from "zod"
import {
	agentJobCreationSchema,
	agentJobMessageSchema,
	agentJobResultSchema,
} from "@/agents.schema"
import { organizationSchema } from "@/auth.server"
import { slateMemberSchema } from "@/slate-members.schema"
import { slateSchema } from "@/slates.schema"

const execFile = promisify(execFileCallback)

test("API jobs execute Code Mode and preserve owner and viewer database writes", async ({
	buildWorker,
	cliEnv,
	db,
	directory,
	platform,
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
		.organizations.find((item) => item.slug === seed.web.organization.slug)
	assert(organization, "Initialize the DevEnv organization")
	const created = await fetch(
		`${origin}/api/slates`,
		post({ organization_slug: organization.slug }),
	)
	expect(created.status).toBe(201)
	const slate = slateSchema.parse(await created.json())
	const { ARTIFACTS, DATABASES } = await worker.getEnv()
	await using resources = new AsyncDisposableStack()
	resources.defer(async () => {
		await ARTIFACTS.delete(slate.id)
	})
	await copySlateProject(directory)
	await mkdir(join(directory, "agents/database"), { recursive: true })
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
			databases: { drafts: { mode: "viewer" }, reports: { mode: "owner" } },
			secrets: { ANTHROPIC_API_KEY: { mode: "owner" } },
		}),
	)
	await writeFile(
		join(directory, "agents/database/instructions.md"),
		"Use the requested database tool. These are disposable acceptance databases; the requested SQL writes are authorized. Do not use Bash. Report completion briefly.\n",
	)
	for (const database of ["drafts", "reports"]) await writeDatabase(directory, database)
	const sql =
		"INSERT INTO updates (id, kind, body, created_at) SELECT ?, kind, body, ? FROM updates WHERE id = ? RETURNING id, body"
	const copies = ["drafts", "reports"].map((slug) => ({
		params: ["copy", 2, "seed"],
		slug,
		sql,
	}))
	const cli = join(import.meta.dirname, "../../cli/dist/cli.mjs")
	const git = (...args: string[]) =>
		execFile("git", args, {
			cwd: directory,
			env: {
				...process.env,
				...cliEnv,
				GIT_CONFIG_GLOBAL: join(directory, "gitconfig"),
				GIT_TERMINAL_PROMPT: "0",
			},
		})
	await git("init", "-b", "main")
	await git("config", "user.name", "Pi Database Acceptance")
	await git("config", "user.email", "pi-database-test@example.com")
	await git("add", ".")
	await git("-c", "commit.gpgsign=false", "commit", "-m", "Declare agent databases")
	await git(
		"config",
		"--global",
		`credential.${origin}/git.helper`,
		`${cli} git-credential`,
	)
	await git("push", `${origin}/git/${slate.id}`, "main")
	await db
		.insertInto("slate_member")
		.values(slateMemberSchema.parse({ slate_id: slate.id, user_id: webSession.user.id }))
		.execute()
	const { MEMBER_PROVISIONING, PROVISIONING } = await buildWorker.getEnv()
	const prepared = await PROVISIONING.prepare(
		slate.id,
		(await git("rev-parse", "HEAD")).stdout.trim(),
	)
	{
		await using workflow = await buildWorker.introspectWorkflowInstance(
			"MEMBER_PROVISIONING",
			(await MEMBER_PROVISIONING.create({ params: prepared })).id,
		)
		await workflow.waitForStatus("complete")
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
	const drafts = databases.drafts
	const reports = databases.reports
	assert(drafts && reports)
	const stores = {
		drafts: DATABASES.getByName(drafts.instance_name),
		reports: DATABASES.getByName(reports.instance_name),
	}
	const markers = {
		drafts: `personal-${webSession.user.id}`,
		reports: `org-${organization.id}`,
	}
	for (const slug of ["drafts", "reports"] as const) {
		const database = stores[slug]
		await database.query(
			"INSERT INTO updates (id, kind, body, created_at) VALUES (?, ?, ?, ?)",
			["seed", "proof", markers[slug], 1],
		)
	}
	const url = `${origin}/api/slates/${slate.id}/agents/database/jobs`
	const submitted = await fetch(
		url,
		post({
			prompt: `Use Code Mode to call tools.database_query for each of ${JSON.stringify(copies)}. Copy the seed row in both databases.`,
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
		.filter((message) => message.role === "toolResult" && message.toolName === "codemode")
	expect(toolResults).toContainEqual(
		expect.objectContaining({
			isError: false,
		}),
	)
	const deleted = await fetch(`${url}/${api.job.id}`, { headers, method: "DELETE" })
	expect(deleted.status).toBe(204)
	for (const slug of ["drafts", "reports"] as const) {
		const persisted = await stores[slug].query(
			"SELECT id, body FROM updates ORDER BY created_at",
		)
		expect(persisted.rows).toEqual([
			{ body: markers[slug], id: "seed" },
			{ body: markers[slug], id: "copy" },
		])
	}
}, 900_000)
