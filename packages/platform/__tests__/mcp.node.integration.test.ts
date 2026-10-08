import { cp, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { createPolarCore } from "@polar-sh/sdk/2026-10"
import { getStateExternalCustomers } from "@polar-sh/sdk/2026-10/services/customers"
import { listEvents } from "@polar-sh/sdk/2026-10/services/events"
import { test as base } from "@tests/integration"
import { authorizeMcp } from "@usecontextlayer/dev-env/mcp"
import { signInViewer } from "@usecontextlayer/dev-env/viewer"
import { execa } from "execa"
import { expect } from "vitest"
import { unstable_readConfig } from "wrangler"
import { z } from "zod"
import { appSchema } from "@/apps.schema"
import { saveCustomerState } from "@/billing.server"

const test = base
	.extend("app", async ({ identity, platform }, { onCleanup }) => {
		const created = await fetch(`${platform.origin}/api/apps`, {
			headers: identity.headers,
			method: "POST",
		})
		expect(created.status).toBe(201)
		const app = appSchema.parse(await created.json())
		const { ARTIFACTS } = await platform.worker.getEnv()
		onCleanup(async () => {
			await ARTIFACTS.delete(app.id)
		})
		return app
	})
	.extend("mcpHeaders", ({ app, serviceEnv, webSession }) =>
		authorizeMcp({
			clientId: "https://claude.ai/oauth/claude-code-client-metadata",
			issuer: serviceEnv.issuer,
			redirectUri: "http://127.0.0.1:51234/callback",
			resource: `https://${app.public_hostname}/mcp`,
			webHeaders: webSession.headers,
		}),
	)

test("native dispatcher and platform bind MCP to the app and reject cookie fallback", async ({
	app,
	db,
	dispatcher,
	identity,
	mcpHeaders,
	platform,
	serviceEnv,
	webEnv,
	webSession,
}) => {
	const worker = dispatcher.worker
	const headers = Object.fromEntries(mcpHeaders)
	const resource = `https://${app.public_hostname}/mcp`
	const metadataUrl = `https://${app.public_hostname}/.well-known/oauth-protected-resource/mcp`
	const metadata = await worker.fetch(metadataUrl)
	expect(metadata.status).toBe(200)
	expect(await metadata.json()).toMatchObject({
		authorization_servers: [serviceEnv.issuer],
		resource,
		scopes_supported: ["mcp:access"],
	})
	const viewerHeaders = Object.fromEntries(
		await signInViewer({
			authURL: webEnv.CTX_VIEWER_AUTH_URL,
			returnTo: `https://${app.public_hostname}/`,
			webHeaders: webSession.headers,
		}),
	)
	const challenge = await worker.fetch(resource, { headers: viewerHeaders })
	expect(challenge.status).toBe(401)
	expect(challenge.headers.get("www-authenticate")).toContain(
		`resource_metadata="${metadataUrl}"`,
	)
	expect(challenge.headers.get("location")).toBeNull()
	// Identity and private viewing succeed; this fixture has no subscription state.
	expect((await worker.fetch(resource, { headers })).status).toBe(402)
	const other = await db
		.insertInto("app")
		.values({
			owner_user_id: identity.user.id,
			public_hostname: `${crypto.randomUUID()}.${platform.env.CTX_APPS_DOMAIN}`,
			visibility: "private",
		})
		.returningAll()
		.executeTakeFirstOrThrow()
	expect(
		(await worker.fetch(`https://${other.public_hostname}/mcp`, { headers })).status,
	).toBe(401)
	expect((await platform.worker.fetch("/api/apps", { headers })).status).toBe(401)
	expect(
		(
			await platform.worker.fetch(
				`/api/apps/resolve?hostname=${app.public_hostname}&pathname=/slate.json`,
				{ headers: viewerHeaders },
			)
		).status,
	).toBe(200)
})

test("discovers a View and invokes an authored Worker once through native MCP", {
	timeout: 300_000,
}, async ({ app, db, directory, dispatcher, identity, mcpHeaders, serviceEnv }) => {
	const polar = createPolarCore({
		accessToken: serviceEnv.polarEnv.POLAR_ACCESS_TOKEN,
		environment: serviceEnv.polarEnv.POLAR_ENVIRONMENT,
	})
	const state = await getStateExternalCustomers(polar)(identity.user.id)
	await saveCustomerState(db, state, null)
	await cp(new URL("./fixtures/mcp", import.meta.url), directory, { recursive: true })
	await cp(
		new URL("../../cli/template/workers/local-tools", import.meta.url),
		join(directory, "workers/local-tools"),
		{ recursive: true },
	)
	await symlink(
		fileURLToPath(new URL("../node_modules", import.meta.url)),
		join(directory, "node_modules"),
		"dir",
	)
	const config = unstable_readConfig({
		config: fileURLToPath(new URL("../../dispatcher/wrangler.jsonc", import.meta.url)),
		env: "test",
	})
	const accountId = z.string().parse(config.account_id)
	const namespace = z.string().parse(config.dispatch_namespaces[0]?.namespace)
	await writeFile(
		join(directory, "wrangler.jsonc"),
		JSON.stringify({
			account_id: accountId,
			compatibility_date: config.compatibility_date,
			main: "./workers/app.ts",
			name: app.id,
		}),
	)
	const execute = execa({
		cwd: directory,
		localDir: new URL("../", import.meta.url),
		preferLocal: true,
	})
	await execute("vite", ["build"])
	await execute("wrangler", [
		"deploy",
		"--config",
		join(directory, "build/server/wrangler.json"),
		"--dispatch-namespace",
		namespace,
		"--env=",
	])
	await using resources = new AsyncDisposableStack()
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
	const client = new Client({ name: "native-mcp-integration", version: "1" })
	resources.defer(() => client.close())
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`https://${app.public_hostname}/mcp`), {
			fetch: dispatcher.worker.fetch.bind(dispatcher.worker) as unknown as typeof fetch,
			requestInit: { headers: mcpHeaders },
		}),
	)
	const tools = await client.listTools()
	expect(tools.tools).toMatchObject([
		{ _meta: { ui: { resourceUri: "ui://echo/index.html" } }, name: "echo" },
	])
	const view = await client.readResource({ uri: "ui://echo/index.html" })
	expect(view.contents).toMatchObject([
		{
			mimeType: "text/html;profile=mcp-app",
			text: expect.stringContaining("Echo View"),
		},
	])
	const valid = await client.callTool({ arguments: { value: 42 }, name: "echo" })
	expect(valid.structuredContent).toEqual({
		authorization: null,
		runtime: expect.stringContaining("Cloudflare-Workers"),
		value: 42,
	})
	const invalid = await client.callTool({
		arguments: { value: "wrong type" },
		name: "echo",
	})
	expect(invalid.isError).toBe(true)
	await expect
		.poll(
			async () => {
				const events = await listEvents(polar)({
					external_customer_id: identity.user.id,
					metadata: { user_code_worker_id: app.id },
				})
				return events.items
					.filter((event) => event.source === "user")
					.map((event) => ({ clips: event.metadata.clips, name: event.name }))
			},
			{ interval: 1000, timeout: 60_000 },
		)
		.toEqual([{ clips: 1, name: "tool_call" }])
})
