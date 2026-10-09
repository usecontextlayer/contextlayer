import assert from "node:assert/strict"
import { cp, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createPolarCore } from "@polar-sh/sdk/2026-10"
import { getStateExternalCustomers } from "@polar-sh/sdk/2026-10/services/customers"
import { listEvents } from "@polar-sh/sdk/2026-10/services/events"
import { executionTest as test } from "@tests/integration"
import { signInViewer } from "@usecontextlayer/dev-env/viewer"
import { appResourcesSchema } from "@usecontextlayer/shared/app-resources"
import { connectionsSchema } from "@usecontextlayer/shared/connections"
import type { Databases } from "@usecontextlayer/shared/databases-worker"
import type {
	HostedExecution,
	Tools,
	ToolsProps,
} from "@usecontextlayer/shared/tools-worker"
import { execa } from "execa"
import { expect } from "vitest"
import { z } from "zod"
import { appSchema } from "@/apps.schema"
import { saveCustomerState } from "@/billing.server"

test("native resource capabilities enforce access and report exact app-owner tool usage", {
	timeout: 660_000,
}, async ({
	cliEnv,
	db,
	directory,
	execution,
	identity,
	organization,
	platform,
	serviceEnv,
	webEnv,
	webSession,
}) => {
	const { origin, worker } = platform
	const { headers, user } = identity
	const connected = await fetch(`${origin}/api/connections?toolkit=gmail`, { headers })
	expect(connected.status).toBe(200)
	const { connections } = connectionsSchema.parse(await connected.json())
	const connection = connections.find(({ status }) => status === "ACTIVE")
	assert(
		connection,
		"Authorize Gmail for the local development user with pnpm dev:ctx connections add gmail, then approve the link in your browser.",
	)
	const { ARTIFACTS, DATABASES } = await worker.getEnv()
	await using resources = new AsyncDisposableStack()
	const post = (body: unknown) => ({
		body: JSON.stringify(body),
		headers: { ...headers, "content-type": "application/json" },
		method: "POST",
	})
	const callExecution = async <Method extends keyof HostedExecution>(
		method: Method,
		args: Parameters<HostedExecution[Method]>,
	) => {
		const response = await execution.worker.fetch(`http://execution/${method}`, {
			body: JSON.stringify(args),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		expect(response.status).toBe(200)
		return response.json()
	}
	const callCapability = <Method extends "tools" | "databases">(
		method: Method,
		props: ToolsProps,
		args: Method extends "tools"
			? Parameters<Tools["call"]>
			: Parameters<Databases["query"]>,
	) =>
		execution.worker.fetch(`http://execution/${method}`, {
			body: JSON.stringify([props, args]),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
	const polar = createPolarCore({
		accessToken: serviceEnv.polarEnv.POLAR_ACCESS_TOKEN,
		environment: serviceEnv.polarEnv.POLAR_ENVIRONMENT,
	})
	for (const [body, ownerId] of [
		[{}, identity.user.id],
		[{ organization_slug: organization.slug }, organization.id],
	] as const) {
		const created = await fetch(`${origin}/api/apps`, post(body))
		expect(created.status).toBe(201)
		const app = appSchema.parse(await created.json())
		expect(app.owner_user_id ?? app.owner_organization_id).toBe(ownerId)
		resources.defer(async () => {
			await ARTIFACTS.delete(app.id)
		})
		const viewerHeaders = await signInViewer({
			authURL: webEnv.CTX_VIEWER_AUTH_URL,
			returnTo: `https://${app.public_hostname}/`,
			webHeaders: webSession.headers,
		})
		const viewerToken = decodeURIComponent(
			new Headers(viewerHeaders).get("cookie")?.match(/ctx-viewer-auth=([^;]+)/)?.[1] ??
				"",
		)
		assert(viewerToken)
		const props = {
			appId: app.id,
			credential: { token: viewerToken, type: "session" },
		} as const
		const blocked = await fetch(
			`${origin}/api/apps/resolve?${new URLSearchParams({ hostname: app.public_hostname, pathname: "/" })}`,
			{ headers: viewerHeaders },
		)
		expect(blocked.status).toBe(402)
		const message = await blocked.text()
		expect(message.length).toBeGreaterThan(0)
		const refusal = { allowed: false, message, reason: "subscription-required" }
		expect(
			await callExecution("callTool", [
				app.id,
				viewerToken,
				{ arguments: {}, slug: "mail", tool: "GMAIL_GET_PROFILE" },
			]),
		).toEqual(refusal)
		expect(
			await callExecution("queryDatabase", [
				app.id,
				viewerToken,
				{ slug: "drafts", sql: "SELECT * FROM updates" },
			]),
		).toEqual(refusal)

		await saveCustomerState(db, await getStateExternalCustomers(polar)(ownerId), null)
		const project = join(directory, app.id)
		await mkdir(join(project, "public"), { recursive: true })
		await writeFile(
			join(project, "public/slate.json"),
			JSON.stringify({
				connections: { mail: { mode: "viewer", toolkit: "gmail" } },
				databases: { drafts: { mode: "viewer" }, reports: { mode: "owner" } },
			}),
		)
		for (const slug of ["drafts", "reports"]) {
			await cp(
				new URL("../../cli/template/databases/updates/migrations", import.meta.url),
				join(project, "databases", slug, "migrations"),
				{ recursive: true },
			)
		}
		const execute = execa({ cwd: project })
		const git = (...args: string[]) =>
			execute("git", args, {
				env: {
					...cliEnv,
					GIT_CONFIG_GLOBAL: join(project, "gitconfig"),
					GIT_TERMINAL_PROMPT: "0",
				},
			})
		const cli = join(import.meta.dirname, "../../cli/dist/cli.mjs")
		await git(
			"config",
			"--global",
			`credential.${origin}/git.helper`,
			`${cli} git-credential`,
		)
		await git("init", "-b", "main")
		await git("config", "user.name", "Execution Test")
		await git("config", "user.email", "execution-test@example.com")
		await git("remote", "add", "origin", `${origin}/git/${app.id}`)
		await git("add", "public", "databases")
		await git("-c", "commit.gpgsign=false", "commit", "-m", "Declare app resources")
		await git("push", "origin", "main")
		expect(
			await callExecution("callTool", [
				app.id,
				viewerToken,
				{ arguments: {}, slug: "other", tool: "EXAMPLE" },
			]),
		).toEqual({ allowed: false, reason: "not-declared" })
		const unassigned = await callCapability("tools", props, [
			"mail",
			"GMAIL_GET_PROFILE",
			{ user_id: "me" },
		])
		expect(unassigned.status).toBe(409)
		expect(await unassigned.json()).toEqual({
			reason: "connection-required",
			slug: "mail",
		})
		const undeclared = await callCapability("tools", props, ["other", "EXAMPLE", {}])
		expect(undeclared.status).toBe(400)
		expect(await undeclared.json()).toEqual({ error: "not-declared" })
		await db.deleteFrom("app_member").where("app_id", "=", app.id).execute()
		const membership = await callCapability("tools", props, [
			"mail",
			"GMAIL_GET_PROFILE",
			{ user_id: "me" },
		])
		expect(membership.status).toBe(400)
		expect(await membership.json()).toEqual({ error: "membership-required" })
		const databaseMembership = await callCapability("databases", props, [
			"drafts",
			"SELECT id, body FROM updates ORDER BY created_at",
		])
		expect(databaseMembership.status).toBe(400)
		expect(await databaseMembership.json()).toEqual({ error: "membership-required" })
		const joined = await fetch(`${origin}/api/apps/${app.id}/join`, {
			headers,
			method: "POST",
		})
		expect(joined.status).toBe(200)
		expect(await joined.json()).toEqual({ app_id: app.id, user_id: user.id })
		const assigned = await fetch(
			`${origin}/api/apps/${app.id}/connections/assign`,
			post({ connection_id: connection.id, slug: "mail" }),
		)
		expect(assigned.status).toBe(200)
		const configuration = await fetch(
			`${origin}/api/apps/${app.id}/resources/list`,
			post({}),
		)
		expect(configuration.status).toBe(200)
		const { resources: configured } = appResourcesSchema.parse(await configuration.json())
		for (const slug of ["drafts", "reports"]) {
			const database = configured.databases[slug]
			assert(database)
			expect(database.owner).toEqual(
				slug === "drafts" || ownerId === user.id
					? { id: user.id, type: "user" }
					: { id: organization.id, type: "organization" },
			)
			await DATABASES.getByName(database.instance_name).query(
				"INSERT INTO updates (id, kind, body, created_at) VALUES (?, ?, ?, ?)",
				["native-proof", "proof", app.id, 1],
			)
			const response = await callCapability("databases", props, [
				slug,
				"SELECT id, body FROM updates ORDER BY created_at",
			])
			expect(response.status).toBe(200)
			expect(await response.json()).toMatchObject({
				columns: ["id", "body"],
				rows: [["native-proof", app.id]],
			})
		}
		const toolResponse = await callCapability("tools", props, [
			"mail",
			"GMAIL_GET_PROFILE",
			{ user_id: "me" },
		])
		expect(toolResponse.status).toBe(200)
		const result = z
			.object({ data: z.unknown(), logId: z.string().min(1) })
			.parse(await toolResponse.json())
		expect(result.data).toBeDefined()
		await expect
			.poll(
				async () => {
					const events = await listEvents(polar)({
						external_customer_id: ownerId,
						metadata: { user_code_worker_id: app.id },
					})
					return events.items
						.filter((event) => event.source === "user")
						.map((event) => ({ clips: event.metadata.clips, name: event.name }))
						.sort((a, b) => a.name.localeCompare(b.name))
				},
				{ interval: 1000, timeout: 300_000 },
			)
			.toEqual([{ clips: 1, name: "tool_call" }])
	}
})
