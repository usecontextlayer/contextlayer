import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createPolarCore } from "@polar-sh/sdk/2026-10"
import { getStateExternalCustomers } from "@polar-sh/sdk/2026-10/services/customers"
import { listEvents } from "@polar-sh/sdk/2026-10/services/events"
import { dispatcherTest as test } from "@tests/integration"
import { signInViewer } from "@usecontextlayer/dev-env/viewer"
import { execa } from "execa"
import { expect } from "vitest"
import { unstable_readConfig } from "wrangler"
import { z } from "zod"
import { saveCustomerState } from "@/billing.server"
import { slateSchema } from "@/slates.schema"

test("real dispatch strips viewer credentials and reports exact slate-Owner request usage", {
	timeout: 660_000,
}, async ({
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
	const wrangler = fileURLToPath(
		new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
	)
	for (const [body, ownerId] of [
		[{}, user.id],
		[{ organization_slug: organization.slug }, organization.id],
	] as const) {
		await saveCustomerState(db, await getStateExternalCustomers(polar)(ownerId), null)
		const created = await fetch(`${origin}/api/slates`, {
			body: JSON.stringify(body),
			headers: { ...headers, "content-type": "application/json" },
			method: "POST",
		})
		expect(created.status).toBe(201)
		const slate = slateSchema.parse(await created.json())
		resources.defer(async () => {
			await ARTIFACTS.delete(slate.id)
		})
		expect(slate.owner_user_id ?? slate.owner_organization_id).toBe(ownerId)
		const slateDir = join(directory, slate.id)
		await mkdir(slateDir)
		await writeFile(
			join(slateDir, "index.js"),
			`export default {
				async fetch(request) {
					return Response.json({
						authorization: request.headers.get("authorization"),
						body: await request.text(),
						cookie: request.headers.get("cookie"),
						method: request.method,
					})
				}
			}`,
		)
		const workerConfig = join(slateDir, "wrangler.json")
		await writeFile(
			workerConfig,
			JSON.stringify({
				account_id: accountId,
				compatibility_date: config.compatibility_date,
				main: "index.js",
				name: slate.id,
			}),
		)
		const execute = execa({ cwd: slateDir })
		await execute(process.execPath, [
			wrangler,
			"deploy",
			"--config",
			workerConfig,
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
					slate.id,
					"--dispatch-namespace",
					namespace,
					"--force",
				],
				{ env: { CLOUDFLARE_ACCOUNT_ID: accountId } },
			)
		})
		const viewerHeaders = await signInViewer({
			authURL: webEnv.CTX_VIEWER_AUTH_URL,
			returnTo: `https://${slate.public_hostname}/`,
			webHeaders: webSession.headers,
		})
		const viewerCookie = z
			.string()
			.min(1)
			.parse(viewerHeaders.get("cookie")?.match(/(?:^|;\s*)(ctx-viewer-auth=[^;]+)/)?.[1])
		for (const method of ["GET", "POST"]) {
			const response = await dispatcher.worker.fetch(
				`https://${slate.public_hostname}/`,
				{
					headers: {
						authorization: headers.authorization,
						cookie: viewerCookie,
					},
					method,
					...(method === "POST" ? { body: "usage test action" } : {}),
				},
			)
			expect(response.status).toBe(200)
			expect(await response.json()).toEqual({
				authorization: null,
				body: method === "POST" ? "usage test action" : "",
				cookie: null,
				method,
			})
		}
		await expect
			.poll(
				async () => {
					const events = await listEvents(polar)({
						external_customer_id: ownerId,
						metadata: { user_code_worker_id: slate.id },
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
			])
	}
})
