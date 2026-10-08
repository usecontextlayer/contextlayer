import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createPolarCore } from "@polar-sh/sdk/2026-10"
import { getStateExternalCustomers } from "@polar-sh/sdk/2026-10/services/customers"
import { listEvents } from "@polar-sh/sdk/2026-10/services/events"
import { test } from "@tests/integration"
import { connectionsSchema } from "@usecontextlayer/shared/connections"
import { execa } from "execa"
import { expect } from "vitest"
import { unstable_readConfig } from "wrangler"
import { z } from "zod"
import { appSchema } from "@/apps.schema"
import { saveCustomerState } from "@/billing.server"
import { toolResultSchema } from "@/tools.schema"

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
		await mkdir(join(appDir, "public"), { recursive: true })
		const slate = { connections: { mail: { mode: "viewer", toolkit: "gmail" } } }
		await writeFile(join(appDir, "public/slate.json"), JSON.stringify(slate))
		await writeFile(
			join(appDir, "index.js"),
			`export default {
				async fetch(request) {
					return Response.json({
						method: request.method,
						authorization: request.headers.get("authorization"),
						body: await request.text(),
					})
				}
			}`,
		)
		const workerConfig = join(appDir, "wrangler.json")
		await writeFile(
			workerConfig,
			JSON.stringify({
				account_id: accountId,
				compatibility_date: config.compatibility_date,
				main: "index.js",
				name: app.id,
			}),
		)
		const execute = execa({ cwd: appDir })
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
		await git("add", "public", "index.js", "wrangler.json")
		await git("-c", "commit.gpgsign=false", "commit", "-m", "Declare usage test app")
		await git("push", "origin", "main")
		await execute(process.execPath, [
			wrangler,
			"deploy",
			"--config",
			workerConfig,
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
		const assigned = await fetch(
			`${origin}/api/apps/${app.id}/connections/assign`,
			post({ connection_id: connection.id, slug: "mail" }),
		)
		expect(assigned.status).toBe(200)
		for (const method of ["GET", "POST"]) {
			const response = await dispatcher.worker.fetch(`https://${app.public_hostname}/`, {
				headers,
				method,
				...(method === "POST" ? { body: "usage test action" } : {}),
			})
			expect(response.status).toBe(200)
			expect(await response.json()).toEqual({
				authorization: null,
				body: method === "POST" ? "usage test action" : "",
				method,
			})
		}
		const execution = await fetch(
			`${origin}/api/apps/${app.id}/tools/call`,
			post({
				arguments: { user_id: "me" },
				slug: "mail",
				tool: "GMAIL_GET_PROFILE",
			}),
		)
		expect(execution.status).toBe(200)
		const result = toolResultSchema.parse(await execution.json())
		expect(result.error).toBeNull()
		expect(result.logId.length).toBeGreaterThan(0)
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
				{ clips: 1, name: "loader_call" },
				{ clips: 1, name: "tool_call" },
			])
	}
})
