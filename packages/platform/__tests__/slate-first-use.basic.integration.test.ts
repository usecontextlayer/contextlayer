import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "@tests/slate-first-use"
import { databaseResultSchema } from "@usecontextlayer/shared/databases"
import { expect } from "vitest"

test("first-use refusals and owner-only requests do not create membership", {
	timeout: 900_000,
}, async ({ execution, firstUseSlate, platform }) => {
	const { checkout, headers, members, props, push, query, slate } = firstUseSlate
	expect(await members()).toEqual([])
	await mkdir(join(checkout, "agents/daily"), { recursive: true })
	await writeFile(
		join(checkout, "public/slate.json"),
		JSON.stringify({
			connections: {},
			databases: { drafts: { mode: "viewer" }, reports: { mode: "owner" } },
		}),
	)
	await writeFile(
		join(checkout, "agents/daily/instructions.md"),
		"Write an update in your declared database.\n",
	)
	const agentDeclaration = join(checkout, "agents/daily/slate.json")
	await writeFile(
		agentDeclaration,
		JSON.stringify({
			connections: { mail: { mode: "viewer", toolkit: "gmail" } },
			databases: { inbox: { mode: "viewer" } },
		}),
	)
	await push("Declare first-use resources")
	const agentOnly = await execution.worker.fetch("http://execution/tools", {
		body: JSON.stringify([props, ["mail", "GMAIL_GET_PROFILE", { user_id: "me" }]]),
		headers: { "content-type": "application/json" },
		method: "POST",
	})
	expect(agentOnly.status).toBe(400)
	expect(await agentOnly.json()).toEqual({ error: "not-declared" })
	const privateOwner = await query("SELECT 1 AS resolved", [], "reports")
	expect(privateOwner.status).toBe(200)
	expect(databaseResultSchema.parse(await privateOwner.json()).rows).toEqual([
		{ resolved: 1 },
	])
	expect(await members()).toEqual([])
	const missingConnection = await query("SELECT * FROM updates")
	expect(missingConnection.status).toBe(409)
	expect(await missingConnection.json()).toEqual({
		reason: "connection-required",
		slug: "mail",
	})
	expect(await members()).toEqual([])
	const name = `STORY_SECRET_${randomUUID().replaceAll("-", "").toUpperCase()}`
	await writeFile(
		agentDeclaration,
		JSON.stringify({
			connections: {},
			databases: { inbox: { mode: "viewer" } },
			secrets: { [name]: { mode: "viewer" } },
		}),
	)
	await push("Require a viewer secret")
	const missingSecret = await query("SELECT * FROM updates")
	expect(missingSecret.status).toBe(409)
	expect(await missingSecret.json()).toEqual({ name, reason: "secret-required" })
	expect(await members()).toEqual([])
	const explicitJoin = await fetch(`${platform.origin}/api/slates/${slate.id}/join`, {
		headers,
		method: "POST",
	})
	expect(explicitJoin.status).toBe(404)
	expect(await members()).toEqual([])
	const schema = await fetch(`${platform.origin}/api/openapi.json`)
	expect(await schema.json()).not.toHaveProperty(["paths", "/slates/{target}/join"])
	const setVisibility = (visibility: "public" | "private") =>
		fetch(`${platform.origin}/api/slates/${slate.id}`, {
			body: JSON.stringify({ visibility }),
			headers,
			method: "PATCH",
		})
	expect((await setVisibility("public")).status).toBe(200)
	const publicViewer = await query("SELECT * FROM updates")
	expect(publicViewer.status).toBe(400)
	expect(await publicViewer.json()).toEqual({ error: "forbidden" })
	const publicOwner = await query("SELECT 1 AS resolved", [], "reports")
	expect(publicOwner.status).toBe(200)
	expect(databaseResultSchema.parse(await publicOwner.json()).rows).toEqual([
		{ resolved: 1 },
	])
	expect(await members()).toEqual([])
})
