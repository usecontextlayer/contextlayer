import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createPolarCore } from "@polar-sh/sdk/2026-10"
import { listEvents } from "@polar-sh/sdk/2026-10/services/events"
import { executionTest as test } from "@tests/integration"
import { createSlateProject } from "@usecontextlayer/dev-env/slate"
import { signInViewer } from "@usecontextlayer/dev-env/viewer"
import { accountsSchema } from "@usecontextlayer/shared/accounts"
import type {
	HostedExecution,
	Tools,
	ToolsProps,
} from "@usecontextlayer/shared/tools-worker"
import { execa } from "execa"
import { expect } from "vitest"
import { z } from "zod"
import { listSlateMembers } from "@/slate-members.server"
import { slateSchema } from "@/slates.schema"

test("native Tools capability enforces access and reports exact slate-Owner tool usage", {
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
	const connected = await fetch(`${origin}/api/accounts?toolkit=gmail`, { headers })
	expect(connected.status).toBe(200)
	const { accounts } = accountsSchema.parse(await connected.json())
	const account = accounts[0]
	assert(
		account,
		"Connect a Gmail account for the DevEnv user with pnpm dev:ctx accounts add gmail, then approve the link in your browser.",
	)
	const { ARTIFACTS } = await worker.getEnv()
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
	const callTools = (props: ToolsProps, args: Parameters<Tools["call"]>) =>
		execution.worker.fetch("http://execution/tools", {
			body: JSON.stringify([props, args]),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
	const polar = createPolarCore({
		accessToken: serviceEnv.polarEnv.POLAR_ACCESS_TOKEN,
		environment: serviceEnv.polarEnv.POLAR_ENVIRONMENT,
	})
	const slateWithoutPolarCustomer = await db
		.insertInto("slate")
		.values({
			owner_user_id: randomUUID(),
			public_hostname: "missing-customer.example.com",
			visibility: "public",
		})
		.returningAll()
		.executeTakeFirstOrThrow()
	// Keep the viewer's personal resources distinct from the slate Owner's resources.
	const created = await fetch(
		`${origin}/api/slates`,
		post({ organization_slug: organization.slug }),
	)
	expect(created.status).toBe(201)
	const slate = slateSchema.parse(await created.json())
	expect(slate.owner_organization_id).toBe(organization.id)
	resources.defer(async () => {
		await ARTIFACTS.delete(slate.id)
	})
	const viewerHeaders = await signInViewer({
		authURL: webEnv.CTX_VIEWER_AUTH_URL,
		returnTo: `https://${slate.public_hostname}/`,
		webHeaders: webSession.headers,
	})
	const viewerToken = decodeURIComponent(
		new Headers(viewerHeaders).get("cookie")?.match(/ctx-viewer-auth=([^;]+)/)?.[1] ?? "",
	)
	assert(viewerToken)
	const props = {
		credential: { token: viewerToken, type: "session" },
		slateId: slate.id,
	} as const
	const blocked = await fetch(
		`${origin}/api/slates/resolve?${new URLSearchParams({ hostname: slateWithoutPolarCustomer.public_hostname, pathname: "/" })}`,
		{ headers: viewerHeaders },
	)
	expect(blocked.status).toBe(402)
	const message = await blocked.text()
	expect(message.length).toBeGreaterThan(0)
	const refusal = { allowed: false, message, reason: "subscription-required" }
	expect(
		await callExecution("callTool", [
			slateWithoutPolarCustomer.id,
			viewerToken,
			{ arguments: {}, slug: "mail", tool: "GMAIL_GET_PROFILE" },
		]),
	).toEqual(refusal)

	const checkout = join(directory, slate.id)
	await createSlateProject(resolve(import.meta.dirname, "../../.."), checkout)
	await writeFile(
		join(checkout, "public/slate.json"),
		JSON.stringify({ connections: { mail: { mode: "viewer", toolkit: "gmail" } } }),
	)
	const execute = execa({ cwd: checkout })
	const git = (...args: string[]) =>
		execute("git", args, {
			env: {
				...cliEnv,
				GIT_CONFIG_GLOBAL: join(checkout, "gitconfig"),
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
	await git("remote", "add", "origin", `${origin}/git/${slate.id}`)
	await git("add", ".")
	await git("-c", "commit.gpgsign=false", "commit", "-m", "Declare app resources")
	await git("push", "origin", "main")
	expect(
		await callExecution("callTool", [
			slate.id,
			viewerToken,
			{ arguments: {}, slug: "other", tool: "EXAMPLE" },
		]),
	).toEqual({ allowed: false, reason: "not-declared" })
	const unassigned = await callTools(props, [
		"mail",
		"GMAIL_GET_PROFILE",
		{ user_id: "me" },
	])
	expect(unassigned.status).toBe(409)
	expect(await unassigned.json()).toEqual({
		reason: "connection-required",
		slug: "mail",
	})
	const undeclared = await callTools(props, ["other", "EXAMPLE", {}])
	expect(undeclared.status).toBe(400)
	expect(await undeclared.json()).toEqual({ error: "not-declared" })
	const assigned = await fetch(
		`${origin}/api/slates/${slate.id}/connections/assign`,
		post({ account_id: account.id, slug: "mail" }),
	)
	expect(assigned.status).toBe(200)
	const member = { slate_id: slate.id, user_id: user.id }
	expect(await listSlateMembers(db, slate.id)).toEqual([member])
	await db
		.deleteFrom("slate_connection_assignment")
		.where("slate_id", "=", slate.id)
		.execute()
	const missingForMember = await callTools(props, [
		"mail",
		"GMAIL_GET_PROFILE",
		{ user_id: "me" },
	])
	expect(missingForMember.status).toBe(409)
	expect(await missingForMember.json()).toEqual({
		reason: "connection-required",
		slug: "mail",
	})
	expect(await listSlateMembers(db, slate.id)).toEqual([member])
	expect(
		(
			await fetch(
				`${origin}/api/slates/${slate.id}/connections/assign`,
				post({ account_id: account.id, slug: "mail" }),
			)
		).status,
	).toBe(200)
	const toolResponse = await callTools(props, [
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
					external_customer_id: organization.id,
					metadata: { user_code_worker_id: slate.id },
				})
				return events.items
					.filter((event) => event.source === "user")
					.map((event) => ({ clips: event.metadata.clips, name: event.name }))
					.sort((a, b) => a.name.localeCompare(b.name))
			},
			{ timeout: 300_000 },
		)
		.toEqual([{ clips: 1, name: "tool_call" }])
})
