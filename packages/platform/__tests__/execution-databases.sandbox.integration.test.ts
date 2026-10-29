import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { writeDatabase } from "@tests/database-project"
import { executionTest as test } from "@tests/integration"
import { createSlateProject } from "@usecontextlayer/dev-env/slate"
import { signInViewer } from "@usecontextlayer/dev-env/viewer"
import { accountsSchema } from "@usecontextlayer/shared/accounts"
import type { Databases } from "@usecontextlayer/shared/databases-worker"
import { slateResourcesSchema } from "@usecontextlayer/shared/slate-resources"
import type { HostedExecution, ToolsProps } from "@usecontextlayer/shared/tools-worker"
import { execa } from "execa"
import { expect } from "vitest"
import { slateSchema } from "@/slates.schema"

test("native Databases capability enforces access and routes each database to its declared Owner", {
	timeout: 660_000,
}, async ({
	cliEnv,
	db,
	directory,
	execution,
	identity,
	organization,
	platform,
	provisioning,
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
	const { ARTIFACTS, DATABASES } = await worker.getEnv()
	const { PROVISIONING, MEMBER_PROVISIONING } = await provisioning.worker.getEnv()
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
	const callDatabases = (props: ToolsProps, args: Parameters<Databases["query"]>) =>
		execution.worker.fetch("http://execution/databases", {
			body: JSON.stringify([props, args]),
			headers: { "content-type": "application/json" },
			method: "POST",
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
		await callExecution("queryDatabase", [
			slateWithoutPolarCustomer.id,
			viewerToken,
			{ slug: "drafts", sql: "SELECT * FROM updates" },
		]),
	).toEqual(refusal)

	const checkout = join(directory, slate.id)
	await createSlateProject(resolve(import.meta.dirname, "../../.."), checkout)
	await writeFile(
		join(checkout, "public/slate.json"),
		JSON.stringify({
			connections: { mail: { mode: "viewer", toolkit: "gmail" } },
			databases: { drafts: { mode: "viewer" }, reports: { mode: "owner" } },
		}),
	)
	for (const slug of ["drafts", "reports"]) await writeDatabase(checkout, slug)
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
	const prepared = await PROVISIONING.prepare(
		slate.id,
		(await git("rev-parse", "HEAD")).stdout.trim(),
	)
	{
		await using workflow = await provisioning.worker.introspectWorkflowInstance(
			"MEMBER_PROVISIONING",
			(await MEMBER_PROVISIONING.create({ params: prepared })).id,
		)
		await workflow.waitForStatus("complete")
	}
	const databaseRefusal = await callDatabases(props, [
		"drafts",
		"SELECT id, body FROM updates ORDER BY created_at",
	])
	expect(databaseRefusal.status).toBe(409)
	expect(await databaseRefusal.json()).toEqual({
		reason: "connection-required",
		slug: "mail",
	})
	await using workflows =
		await provisioning.worker.introspectWorkflow("MEMBER_PROVISIONING")
	const assigned = await fetch(
		`${origin}/api/slates/${slate.id}/connections/assign`,
		post({ account_id: account.id, slug: "mail" }),
	)
	expect(assigned.status).toBe(200)
	for (const instance of await workflows.get()) {
		await using workflow = instance
		await workflow.waitForStatus("complete")
	}
	const opened = await callDatabases(props, ["drafts", "SELECT id FROM updates"])
	expect(opened.status).toBe(200)
	expect(await opened.json()).toMatchObject({ rows: [] })
	const configuration = await fetch(
		`${origin}/api/slates/${slate.id}/resources/list`,
		post({}),
	)
	expect(configuration.status).toBe(200)
	const { resources: configured } = slateResourcesSchema.parse(await configuration.json())
	for (const slug of ["drafts", "reports"]) {
		const database = configured.databases[slug]
		assert(database)
		expect(database.owner).toEqual(
			slug === "drafts"
				? { id: user.id, type: "personal" }
				: { id: organization.id, type: "organization" },
		)
		await DATABASES.getByName(database.instance_name).query(
			"INSERT INTO updates (id, kind, body, created_at) VALUES (?, ?, ?, ?)",
			["native-proof", "proof", slate.id, 1],
		)
		const response = await callDatabases(props, [
			slug,
			"SELECT id, body FROM updates ORDER BY created_at",
		])
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			columns: ["id", "body"],
			rows: [{ body: slate.id, id: "native-proof" }],
		})
	}
})
