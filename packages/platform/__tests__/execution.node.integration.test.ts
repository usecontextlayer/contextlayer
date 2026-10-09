import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createPolarCore } from "@polar-sh/sdk/2026-10"
import { getStateExternalCustomers } from "@polar-sh/sdk/2026-10/services/customers"
import { executionTest as test } from "@tests/integration"
import { signInViewer } from "@usecontextlayer/dev-env/viewer"
import type { HostedExecution } from "@usecontextlayer/shared/tools-worker"
import { execa } from "execa"
import { expect } from "vitest"
import { appSchema } from "@/apps.schema"
import { saveCustomerState } from "@/billing.server"

test("native Execution enforces billing and published connection declarations", async ({
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
	const { ARTIFACTS } = await worker.getEnv()
	await using resources = new AsyncDisposableStack()
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
	const polar = createPolarCore({
		accessToken: serviceEnv.polarEnv.POLAR_ACCESS_TOKEN,
		environment: serviceEnv.polarEnv.POLAR_ENVIRONMENT,
	})
	for (const [body, ownerId] of [
		[{}, identity.user.id],
		[{ organization_slug: organization.slug }, organization.id],
	] as const) {
		const created = await fetch(`${origin}/api/apps`, {
			body: JSON.stringify(body),
			headers: { ...identity.headers, "content-type": "application/json" },
			method: "POST",
		})
		expect(created.status).toBe(201)
		const app = appSchema.parse(await created.json())
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
			JSON.stringify({ connections: { mail: { mode: "viewer", toolkit: "gmail" } } }),
		)
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
		await git("add", "public/slate.json")
		await git("-c", "commit.gpgsign=false", "commit", "-m", "Declare app connections")
		await git("push", "origin", "main")
		expect(
			await callExecution("callTool", [
				app.id,
				viewerToken,
				{ arguments: {}, slug: "other", tool: "EXAMPLE" },
			]),
		).toEqual({ allowed: false, reason: "not-declared" })
	}
})
