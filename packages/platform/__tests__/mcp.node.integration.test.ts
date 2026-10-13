import { cp, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { dispatcherTest as base } from "@tests/integration"
import { authorizeMcp } from "@usecontextlayer/dev-env/mcp"
import { signInViewer } from "@usecontextlayer/dev-env/viewer"
import { execa } from "execa"
import { expect } from "vitest"
import { unstable_readConfig } from "wrangler"
import { z } from "zod"
import { slateSchema } from "@/slates.schema"

const test = base
	.extend("slate", async ({ identity, platform }, { onCleanup }) => {
		const created = await fetch(`${platform.origin}/api/slates`, {
			headers: identity.headers,
			method: "POST",
		})
		expect(created.status).toBe(201)
		const slate = slateSchema.parse(await created.json())
		const { ARTIFACTS } = await platform.worker.getEnv()
		onCleanup(async () => {
			await ARTIFACTS.delete(slate.id)
		})
		return slate
	})
	.extend("mcpHeaders", ({ slate, serviceEnv, webSession }) =>
		authorizeMcp({
			clientId: "https://claude.ai/oauth/claude-code-client-metadata",
			issuer: serviceEnv.issuer,
			redirectUri: "http://127.0.0.1:51234/callback",
			resource: `https://${slate.public_hostname}/mcp`,
			webHeaders: webSession.headers,
		}),
	)

test("native dispatcher and platform bind MCP to the slate and reject cookie fallback", async ({
	slate,
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
	const resource = `https://${slate.public_hostname}/mcp`
	const metadataUrl = `https://${slate.public_hostname}/.well-known/oauth-protected-resource/mcp`
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
			returnTo: `https://${slate.public_hostname}/`,
			webHeaders: webSession.headers,
		}),
	)
	const challenge = await worker.fetch(resource, { headers: viewerHeaders })
	expect(challenge.status).toBe(401)
	expect(challenge.headers.get("www-authenticate")).toContain(
		`resource_metadata="${metadataUrl}"`,
	)
	expect(challenge.headers.get("location")).toBeNull()
	expect(
		(
			await platform.worker.fetch(
				`/api/slates/resolve?hostname=${slate.public_hostname}&pathname=/mcp`,
				{ headers },
			)
		).status,
	).toBe(200)
	const other = await db
		.insertInto("slate")
		.values({
			owner_user_id: identity.user.id,
			public_hostname: `${crypto.randomUUID()}.${platform.env.CTX_SLATES_DOMAIN}`,
			visibility: "private",
		})
		.returningAll()
		.executeTakeFirstOrThrow()
	expect(
		(await worker.fetch(`https://${other.public_hostname}/mcp`, { headers })).status,
	).toBe(401)
	expect((await platform.worker.fetch("/api/slates", { headers })).status).toBe(401)
	expect(
		(
			await platform.worker.fetch(
				`/api/slates/resolve?hostname=${slate.public_hostname}&pathname=/slate.json`,
				{ headers: viewerHeaders },
			)
		).status,
	).toBe(200)
})

test("private organization member passes billing through slate-bound MCP authorization", async ({
	identity,
	organization,
	platform,
	serviceEnv,
	webSession,
}) => {
	const created = await fetch(`${platform.origin}/api/slates`, {
		body: JSON.stringify({ organization_slug: organization.slug }),
		headers: { ...identity.headers, "content-type": "application/json" },
		method: "POST",
	})
	expect(created.status).toBe(201)
	const slate = slateSchema.parse(await created.json())
	const { ARTIFACTS } = await platform.worker.getEnv()
	await using resources = new AsyncDisposableStack()
	resources.defer(async () => {
		await ARTIFACTS.delete(slate.id)
	})
	expect(slate).toMatchObject({
		owner_organization_id: organization.id,
		owner_user_id: null,
		visibility: "private",
	})
	const resource = `https://${slate.public_hostname}/mcp`
	const headers = await authorizeMcp({
		clientId: "https://claude.ai/oauth/claude-code-client-metadata",
		issuer: serviceEnv.issuer,
		redirectUri: "http://127.0.0.1:51234/callback",
		resource,
		webHeaders: webSession.headers,
	})
	expect(
		(
			await platform.worker.fetch(
				`/api/slates/resolve?hostname=${slate.public_hostname}&pathname=/mcp`,
				{ headers: Object.fromEntries(headers) },
			)
		).status,
	).toBe(200)
})

test("discovers a View and invokes an authored Worker once through native MCP", {
	timeout: 300_000,
}, async ({ slate, directory, dispatcher, mcpHeaders }) => {
	await cp(new URL("./fixtures/mcp", import.meta.url), directory, { recursive: true })
	await cp(
		new URL("../../cli/template/workers/local-resources", import.meta.url),
		join(directory, "workers/local-resources"),
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
			name: slate.id,
		}),
	)
	const execute = execa({
		cwd: directory,
		localDir: new URL("../", import.meta.url),
		preferLocal: true,
	})
	await execute("vite", ["build"], { env: { NODE_ENV: "production" } })
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
				slate.id,
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
		new StreamableHTTPClientTransport(new URL(`https://${slate.public_hostname}/mcp`), {
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
})
