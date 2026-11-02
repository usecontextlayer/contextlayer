import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "@tests/integration"
import { copySlateProject } from "@usecontextlayer/dev-env/slate"
import { accountsSchema } from "@usecontextlayer/shared/accounts"
import { slateResourcesSchema } from "@usecontextlayer/shared/slate-resources"
import { execa } from "execa"
import { expect } from "vitest"
import { agentRuntimeScheduleSchema } from "@/agents.schema"
import { slateSchema } from "@/slates.schema"

test("chrome completes agent-only setup and repeated API assignment preserves its personal schedule", {
	timeout: 900_000,
}, async ({ buildWorker, db, directory, platform, webSession }) => {
	const headers = new Headers(webSession.headers)
	headers.set("origin", platform.origin)
	headers.set("content-type", "application/json")
	const post = (body: unknown) => ({
		body: JSON.stringify(body),
		headers,
		method: "POST",
	})
	const catalog = await fetch(`${platform.origin}/api/accounts?toolkit=gmail`, {
		headers,
	})
	expect(catalog.status).toBe(200)
	const account = accountsSchema.parse(await catalog.json()).accounts[0]
	assert(
		account,
		"The native chrome proof requires an existing ACTIVE personal Gmail connected account for the DevEnv user.",
	)
	const { ARTIFACTS } = await platform.worker.getEnv()
	await using cleanup = new AsyncDisposableStack()
	const created = await fetch(`${platform.origin}/api/slates`, post({}))
	expect(created.status, await created.clone().text()).toBe(201)
	const slate = slateSchema.parse(await created.json())
	cleanup.defer(async () => {
		await ARTIFACTS.delete(slate.id)
		await db.deleteFrom("slate").where("id", "=", slate.id).execute()
	})
	const members = () =>
		db
			.selectFrom("slate_member")
			.select("user_id")
			.where("slate_id", "=", slate.id)
			.execute()
	const checkout = directory
	await copySlateProject(checkout)
	await mkdir(join(checkout, "agents/daily/schedules"), { recursive: true })
	await writeFile(
		join(checkout, "public/slate.json"),
		JSON.stringify({ connections: {} }),
	)
	await writeFile(
		join(checkout, "agents/daily/slate.json"),
		JSON.stringify({
			connections: {
				primary: { mode: "viewer", toolkit: "gmail" },
				secondary: { mode: "owner", toolkit: "gmail" },
			},
		}),
	)
	await writeFile(
		join(checkout, "agents/daily/instructions.md"),
		"Summarize the assigned mailboxes.\n",
	)
	await writeFile(
		join(checkout, "agents/daily/schedules/daily.md"),
		'---\ncron: "0 0 1 1 *"\n---\nSummarize the assigned mailboxes.\n',
	)
	const execute = execa({
		cwd: checkout,
		env: {
			GIT_CONFIG_COUNT: "2",
			GIT_CONFIG_KEY_0: "http.extraHeader",
			GIT_CONFIG_KEY_1: "http.extraHeader",
			GIT_CONFIG_VALUE_0: `Cookie: ${webSession.headers.get("cookie")}`,
			GIT_CONFIG_VALUE_1: `Origin: ${platform.origin}`,
			GIT_TERMINAL_PROMPT: "0",
		},
	})
	const git = (...args: string[]) => execute("git", args)
	await git("init", "-b", "main")
	await git("config", "user.name", "Assignment test")
	await git("config", "user.email", "assignment-test@example.com")
	await git("remote", "add", "origin", `${platform.origin}/git/${slate.id}`)
	await git("add", ".")
	await git("-c", "commit.gpgsign=false", "commit", "-m", "Declare agent-only setup")
	await git("push", "origin", "main")
	const partial = await fetch(
		`${platform.origin}/api/slates/${slate.id}/connections/assign`,
		post({ account_id: account.id, slug: "primary" }),
	)
	expect(partial.status, await partial.clone().text()).toBe(200)
	expect(await partial.json()).toEqual({ account_id: account.id, slug: "primary" })
	expect(await members()).toEqual([])
	const listing = await fetch(
		`${platform.origin}/api/slates/${slate.id}/resources/list`,
		post({}),
	)
	expect(listing.status).toBe(200)
	const { resources } = slateResourcesSchema.parse(await listing.json())
	expect(resources.connections.primary?.account_id).toBe(account.id)
	expect(resources.connections.secondary?.account_id).toBeNull()
	const schedulesUrl = `${platform.origin}/api/slates/${slate.id}/agents/daily/schedules`
	const unconfigured = await fetch(schedulesUrl, { headers })
	expect(unconfigured.status).toBe(200)
	expect(await unconfigured.json()).toEqual([])
	await using workflows = await buildWorker.introspectWorkflow("MEMBER_PROVISIONING")
	const chromeUrl = new URL(`/dashboard/chrome/slates/${slate.id}`, platform.origin)
	chromeUrl.searchParams.set("parentOrigin", `https://${slate.public_hostname}`)
	const chromeHeaders = new Headers(webSession.headers)
	chromeHeaders.set("origin", platform.origin)
	chromeHeaders.set("accept", "text/html")
	const assigned = await fetch(chromeUrl, {
		body: new URLSearchParams({
			account_id: account.id,
			intent: "assign",
			slug: "secondary",
		}),
		headers: chromeHeaders,
		method: "POST",
	})
	expect(assigned.status, await assigned.clone().text()).toBe(200)
	expect(await assigned.text()).toContain("Setup complete")

	expect(await members()).toEqual([{ user_id: webSession.user.id }])
	const started = await workflows.get()
	expect(started).toHaveLength(1)
	for (const workflow of started) await workflow.waitForStatus("complete")
	const scheduled = await fetch(schedulesUrl, { headers })
	expect(scheduled.status).toBe(200)
	const schedules = agentRuntimeScheduleSchema.array().parse(await scheduled.json())
	expect(schedules).toMatchObject([
		{
			cron: "0 0 1 1 *",
			payload: {
				actor: { id: webSession.user.id, type: "user" },
				name: "daily",
				prompt: "Summarize the assigned mailboxes.\n",
				schedule: "daily",
				slateId: slate.id,
			},
			type: "cron",
		},
	])
	const again = await fetch(
		`${platform.origin}/api/slates/${slate.id}/connections/assign`,
		post({ account_id: account.id, slug: "primary" }),
	)
	expect(again.status).toBe(200)
	const preserved = await fetch(schedulesUrl, { headers })
	expect(preserved.status).toBe(200)
	expect(await preserved.json()).toEqual(schedules)
	expect(await workflows.get()).toHaveLength(1)
	expect(await members()).toEqual([{ user_id: webSession.user.id }])
})
