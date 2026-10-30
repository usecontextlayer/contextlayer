import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { writeDatabase } from "@tests/database-project"
import { test } from "@tests/slate-first-use"
import { databaseResultSchema } from "@usecontextlayer/shared/databases"
import { slateResourcesSchema } from "@usecontextlayer/shared/slate-resources"
import { getAgentByName } from "agents/routing"
import { expect } from "vitest"
import { getAgentInstanceName } from "@/agent-instance"

test("first use creates membership and provisions personal databases and schedules", {
	timeout: 900_000,
}, async ({ firstUseSlate, platform, provisioning, webSession }) => {
	const { checkout, headers, members, push, query, slate } = firstUseSlate
	const { DATABASES, AGENTS } = await platform.worker.getEnv()
	expect(await members()).toEqual([])
	await mkdir(join(checkout, "agents/daily/schedules"), { recursive: true })
	await writeFile(
		join(checkout, "public/slate.json"),
		JSON.stringify({
			connections: {},
			databases: { drafts: { mode: "viewer" } },
		}),
	)
	await writeFile(
		join(checkout, "agents/daily/instructions.md"),
		"Write an update in your declared database.\n",
	)
	await writeFile(
		join(checkout, "agents/daily/schedules/daily.md"),
		'---\ncron: "0 0 1 1 *"\n---\nWrite an update.\n',
	)
	await writeFile(
		join(checkout, "agents/daily/slate.json"),
		JSON.stringify({ connections: {}, databases: { inbox: { mode: "viewer" } } }),
	)
	for (const slug of ["drafts", "inbox"]) await writeDatabase(checkout, slug)
	await push("Declare complete first-use resources")
	const configurationResponse = await fetch(
		`${platform.origin}/api/slates/${slate.id}/resources/list`,
		{ body: "{}", headers, method: "POST" },
	)
	expect(configurationResponse.status, await configurationResponse.clone().text()).toBe(
		200,
	)
	const { resources } = slateResourcesSchema.parse(await configurationResponse.json())
	const inbox = resources.databases.inbox
	assert(inbox)
	await expect(
		DATABASES.getByName(inbox.instance_name).query("SELECT * FROM updates"),
	).rejects.toThrow()
	await using workflows =
		await provisioning.worker.introspectWorkflow("MEMBER_PROVISIONING")
	const first = await query("SELECT 1 AS joined")
	expect(first.status, await first.clone().text()).toBe(200)
	expect(databaseResultSchema.parse(await first.json()).rows).toEqual([{ joined: 1 }])
	expect(await members()).toEqual([{ user_id: webSession.user.id }])
	const instance = await getAgentByName(
		AGENTS,
		getAgentInstanceName(slate.id, "daily", { id: webSession.user.id, type: "user" }),
	)
	for (const instance of await workflows.get()) {
		await using workflow = instance
		await workflow.waitForStatus("complete")
	}
	expect(await instance.listSchedules()).toHaveLength(1)
	const schedules = await instance.listSchedules()
	expect(
		(await DATABASES.getByName(inbox.instance_name).query("SELECT * FROM updates")).rows,
	).toEqual([])
	const saved = await query(
		"INSERT INTO updates (id, kind, body, created_at) VALUES (?, ?, ?, ?)",
		["personal", "note", "saved after provisioning", 1],
	)
	expect(saved.status, await saved.clone().text()).toBe(200)
	const second = await query("SELECT body FROM updates WHERE id = ?", ["personal"])
	expect(second.status).toBe(200)
	expect(databaseResultSchema.parse(await second.json()).rows).toEqual([
		{ body: "saved after provisioning" },
	])
	expect(await instance.listSchedules()).toEqual(schedules)
	expect(await members()).toEqual([{ user_id: webSession.user.id }])
})
