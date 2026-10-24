import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { writeDatabase, writeDatabaseProject } from "@tests/database-project"
import { provisioningTest as test } from "@tests/integration"
import { connectionsSchema } from "@usecontextlayer/shared/connections"
import { slateResourcesSchema } from "@usecontextlayer/shared/slate-resources"
import { getAgentByName } from "agents/routing"
import { execa } from "execa"
import { expect } from "vitest"
import { getAgentInstanceName } from "@/agent-instance"
import { slateSchema } from "@/slates.schema"

test("chrome and API final assignments enable agent-only personal resources without opening the app", {
	timeout: 180_000,
}, async ({ db, directory, platform, webSession }) => {
	const headers = new Headers(webSession.headers)
	headers.set("origin", platform.origin)
	headers.set("content-type", "application/json")
	const post = (body: unknown) => ({
		body: JSON.stringify(body),
		headers,
		method: "POST",
	})
	const catalog = await fetch(`${platform.origin}/api/connections?toolkit=gmail`, {
		headers,
	})
	expect(catalog.status).toBe(200)
	const account = connectionsSchema.parse(await catalog.json()).connections[0]
	assert(
		account,
		"The native chrome proof requires an existing ACTIVE personal Gmail connected account for the local development user.",
	)
	const { ARTIFACTS, DATABASES, AGENTS } = await platform.worker.getEnv()
	await using cleanup = new AsyncDisposableStack()
	for (const mode of ["chrome", "api"] as const) {
		const created = await fetch(`${platform.origin}/api/slates`, post({}))
		expect(created.status, await created.clone().text()).toBe(201)
		const slate = slateSchema.parse(await created.json())
		cleanup.defer(async () => {
			await ARTIFACTS.delete(slate.id)
		})
		const members = () =>
			db
				.selectFrom("slate_member")
				.select("user_id")
				.where("slate_id", "=", slate.id)
				.execute()
		const checkout = join(directory, mode)
		await mkdir(join(checkout, "public"), { recursive: true })
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
				databases: { inbox: { mode: "viewer" } },
			}),
		)
		await writeFile(
			join(checkout, "agents/daily/instructions.md"),
			"Write an update in the declared personal database.\n",
		)
		await writeFile(
			join(checkout, "agents/daily/schedules/daily.md"),
			'---\ncron: "0 0 1 1 *"\n---\nWrite a personal update.\n',
		)
		await writeDatabaseProject(checkout)
		await writeDatabase(checkout, "inbox")
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
			post({ connection_id: account.id, slug: "primary" }),
		)
		expect(partial.status, await partial.clone().text()).toBe(200)
		expect(await partial.json()).toEqual({ connection_id: account.id, slug: "primary" })
		expect(await members()).toEqual([])
		const listing = await fetch(
			`${platform.origin}/api/slates/${slate.id}/resources/list`,
			post({}),
		)
		expect(listing.status).toBe(200)
		const { resources } = slateResourcesSchema.parse(await listing.json())
		expect(resources.connections.primary?.connection_id).toBe(account.id)
		expect(resources.connections.secondary?.connection_id).toBeNull()
		const inbox = resources.databases.inbox
		assert(inbox)
		await expect(
			DATABASES.getByName(inbox.instance_name).query("SELECT * FROM updates"),
		).rejects.toThrow()
		const instance = await getAgentByName(
			AGENTS,
			getAgentInstanceName(slate.id, "daily", { id: webSession.user.id, type: "user" }),
		)
		expect(await instance.listSchedules()).toEqual([])
		if (mode === "chrome") {
			const chromeUrl = new URL(`/dashboard/chrome/slates/${slate.id}`, platform.origin)
			chromeUrl.searchParams.set("parentOrigin", `https://${slate.public_hostname}`)
			const chromeHeaders = new Headers(webSession.headers)
			chromeHeaders.set("origin", platform.origin)
			chromeHeaders.set("accept", "text/html")
			const assigned = await fetch(chromeUrl, {
				body: new URLSearchParams({
					connection_id: account.id,
					intent: "assign",
					slug: "secondary",
				}),
				headers: chromeHeaders,
				method: "POST",
			})
			expect(assigned.status, await assigned.clone().text()).toBe(200)
			expect(await assigned.text()).toContain("Setup complete")
		} else {
			const assigned = await fetch(
				`${platform.origin}/api/slates/${slate.id}/connections/assign`,
				post({ connection_id: account.id, slug: "secondary" }),
			)
			expect(assigned.status, await assigned.clone().text()).toBe(200)
			expect(await assigned.json()).toEqual({
				connection_id: account.id,
				slug: "secondary",
			})
		}
		expect(await members()).toEqual([{ user_id: webSession.user.id }])
		const schedules = await instance.listSchedules()
		expect(schedules).toHaveLength(1)
		expect(
			(await DATABASES.getByName(inbox.instance_name).query("SELECT * FROM updates"))
				.rows,
		).toEqual([])
		const again = await fetch(
			`${platform.origin}/api/slates/${slate.id}/connections/assign`,
			post({ connection_id: account.id, slug: "primary" }),
		)
		expect(again.status).toBe(200)
		expect(await instance.listSchedules()).toEqual(schedules)
		expect(await members()).toEqual([{ user_id: webSession.user.id }])
	}
})
