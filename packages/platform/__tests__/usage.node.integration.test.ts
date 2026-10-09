import assert from "node:assert/strict"
import { cp, mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createPolarCore } from "@polar-sh/sdk/2026-10"
import { getStateExternalCustomers } from "@polar-sh/sdk/2026-10/services/customers"
import { listEvents } from "@polar-sh/sdk/2026-10/services/events"
import { dispatcherTest as test } from "@tests/integration"
import { signInViewer } from "@usecontextlayer/dev-env/viewer"
import { appResourcesSchema } from "@usecontextlayer/shared/app-resources"
import { connectionsSchema } from "@usecontextlayer/shared/connections"
import { execa } from "execa"
import { expect } from "vitest"
import { unstable_readConfig } from "wrangler"
import { z } from "zod"
import { appSchema } from "@/apps.schema"
import { saveCustomerState } from "@/billing.server"

test("real dispatch and connected-account execution report exact app-owner usage", {
	timeout: 660_000,
}, async ({
	cliEnv,
	db,
	directory,
	dispatcher,
	identity,
	organization,
	platform,
	serviceEnv,
	webEnv,
	webSession,
}) => {
	const { headers, user } = identity
	const { origin, worker } = platform
	const connected = await fetch(`${origin}/api/connections?toolkit=gmail`, { headers })
	expect(connected.status).toBe(200)
	const { connections } = connectionsSchema.parse(await connected.json())
	const connection = connections.find(({ status }) => status === "ACTIVE")
	assert(
		connection,
		"Authorize Gmail for the local development user with pnpm dev:ctx connections add gmail, then approve the link in your browser.",
	)
	const polar = createPolarCore({
		accessToken: serviceEnv.polarEnv.POLAR_ACCESS_TOKEN,
		environment: serviceEnv.polarEnv.POLAR_ENVIRONMENT,
	})
	const config = unstable_readConfig({
		config: fileURLToPath(new URL("../../dispatcher/wrangler.jsonc", import.meta.url)),
		env: "test",
	})
	const accountId = z.string().parse(config.account_id)
	const namespace = z.string().parse(config.dispatch_namespaces[0]?.namespace)
	const { ARTIFACTS } = await worker.getEnv()
	await using resources = new AsyncDisposableStack()
	const post = (body: unknown) => ({
		body: JSON.stringify(body),
		headers: { ...headers, "content-type": "application/json" },
		method: "POST",
	})
	const cli = join(import.meta.dirname, "../../cli/dist/cli.mjs")
	const wrangler = fileURLToPath(
		new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
	)
	for (const [body, ownerId] of [
		[{}, user.id],
		[{ organization_slug: organization.slug }, organization.id],
	] as const) {
		const state = await getStateExternalCustomers(polar)(ownerId)
		await saveCustomerState(db, state, null)
		const created = await fetch(`${origin}/api/apps`, post(body))
		expect(created.status).toBe(201)
		const app = appSchema.parse(await created.json())
		resources.defer(async () => {
			await ARTIFACTS.delete(app.id)
		})
		expect(app.owner_user_id ?? app.owner_organization_id).toBe(ownerId)
		const appDir = join(directory, app.id)
		await cp(new URL("./fixtures/mcp", import.meta.url), appDir, { recursive: true })
		await cp(
			new URL("../../cli/template/workers/local-resources", import.meta.url),
			join(appDir, "workers/local-resources"),
			{ recursive: true },
		)
		await symlink(
			fileURLToPath(new URL("../node_modules", import.meta.url)),
			join(appDir, "node_modules"),
			"dir",
		)
		await mkdir(join(appDir, "public"), { recursive: true })
		const slate = {
			connections: { mail: { mode: "viewer", toolkit: "gmail" } },
			databases: { drafts: { mode: "viewer" }, reports: { mode: "owner" } },
		}
		await writeFile(join(appDir, "public/slate.json"), JSON.stringify(slate))
		for (const slug of ["drafts", "reports"]) {
			await cp(
				new URL("../../cli/template/databases/updates/migrations", import.meta.url),
				join(appDir, "databases", slug, "migrations"),
				{ recursive: true },
			)
		}
		const workerConfig = join(appDir, "wrangler.json")
		await writeFile(
			workerConfig,
			JSON.stringify({
				account_id: accountId,
				compatibility_date: config.compatibility_date,
				main: "workers/app.ts",
				name: app.id,
			}),
		)
		const execute = execa({
			cwd: appDir,
			localDir: new URL("../", import.meta.url),
			preferLocal: true,
		})
		const git = (...args: string[]) =>
			execute("git", args, {
				env: {
					...cliEnv,
					GIT_CONFIG_GLOBAL: join(appDir, "gitconfig"),
					GIT_TERMINAL_PROMPT: "0",
				},
			})
		await git(
			"config",
			"--global",
			`credential.${origin}/git.helper`,
			`${cli} git-credential`,
		)
		await git("init", "-b", "main")
		await git("config", "user.name", "Usage Test")
		await git("config", "user.email", "usage-test@usecontextlayer.com")
		await git("remote", "add", "origin", `${origin}/git/${app.id}`)
		await git("add", "public", "app", "workers", "databases", "wrangler.json")
		await git("-c", "commit.gpgsign=false", "commit", "-m", "Declare usage test app")
		await git("push", "origin", "main")
		await execute("vite", ["build"], { env: { NODE_ENV: "production" } })
		await execute(process.execPath, [
			wrangler,
			"deploy",
			"--config",
			join(appDir, "build/server/wrangler.json"),
			"--env=",
			"--dispatch-namespace",
			namespace,
		])
		resources.defer(async () => {
			await execute(
				"pnpm",
				[
					"dlx",
					"cf",
					"workers-for-platforms",
					"dispatch-namespaces",
					"scripts",
					"delete",
					app.id,
					"--dispatch-namespace",
					namespace,
					"--force",
				],
				{ env: { CLOUDFLARE_ACCOUNT_ID: accountId } },
			)
		})
		const viewerHeaders = await signInViewer({
			authURL: webEnv.CTX_VIEWER_AUTH_URL,
			returnTo: `https://${app.public_hostname}/`,
			webHeaders: webSession.headers,
		})
		await db
			.deleteFrom("polar_customer_state")
			.where("external_id", "=", ownerId)
			.execute()
		const blocked = await fetch(
			`${origin}/api/apps/resolve?${new URLSearchParams({ hostname: app.public_hostname, pathname: "/" })}`,
			{ headers: viewerHeaders },
		)
		expect(blocked.status).toBe(402)
		const message = await blocked.text()
		expect(message.length).toBeGreaterThan(0)
		await saveCustomerState(db, state, null)
		const request = (path: string, method = "GET") =>
			dispatcher.worker.fetch(`https://${app.public_hostname}${path}`, {
				headers: {
					...Object.fromEntries(viewerHeaders),
					authorization: headers.authorization,
				},
				method,
				...(method === "POST" ? { body: "usage test action" } : {}),
			})
		const unassigned = await request("/execution?slug=mail")
		const setup = await unassigned.json()
		expect(unassigned.status, JSON.stringify(setup)).toBe(409)
		expect(setup).toEqual({
			reason: "connection-required",
			slug: "mail",
		})
		const undeclared = await request("/execution?slug=other")
		expect(undeclared.status).toBe(400)
		expect(await undeclared.json()).toEqual({ error: "not-declared" })
		await db.deleteFrom("app_member").where("app_id", "=", app.id).execute()
		const membership = await request("/execution?slug=mail")
		expect(membership.status).toBe(400)
		expect(await membership.json()).toEqual({ error: "membership-required" })
		const databaseMembership = await request("/execution?database&slug=drafts")
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
		const { DATABASES } = await worker.getEnv()
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
			const response = await request(`/execution?database&slug=${slug}`)
			expect(response.status).toBe(200)
			expect(await response.json()).toMatchObject({
				columns: ["id", "body"],
				rows: [["native-proof", app.id]],
			})
		}
		for (const method of ["GET", "POST"]) {
			const response = await request(method === "POST" ? "/?index" : "/", method)
			expect(response.status).toBe(200)
			expect(await response.json()).toEqual({
				authorization: null,
				body: method === "POST" ? "usage test action" : "",
				cookie: null,
				method,
			})
		}
		const toolResponse = await request("/execution?slug=mail")
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
			.toEqual([
				{ clips: 3, name: "action_call" },
				...Array(8).fill({ clips: 1, name: "loader_call" }),
				{ clips: 1, name: "tool_call" },
			])
	}
})
