import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { writeDatabase } from "@tests/database-project"
import { test as base } from "@tests/integration"
import { createSlateProject } from "@usecontextlayer/dev-env/slate"
import { slateResourcesSchema } from "@usecontextlayer/shared/slate-resources"
import { getAgentByName } from "agents/routing"
import { execa } from "execa"
import { expect } from "vitest"
import { z } from "zod"
import { getAgentInstanceName } from "@/agent-instance"
import { parseSharedSecretsEnv } from "@/env"
import { listSharedSecretNames, loadSharedSecret, secretKey } from "@/secrets.server"
import { slateSchema } from "@/slates.schema"

const names = [
	"CTX_SLATE_SETUP_E2E_20261015_PRIMARY",
	"CTX_SLATE_SETUP_E2E_20261015_SECONDARY",
] as const

const test = base.extend(
	"secretSlate",
	async ({ db, directory, platform, webSession }, { onCleanup }) => {
		const headers = new Headers(webSession.headers)
		headers.set("origin", platform.origin)
		headers.set("content-type", "application/json")
		const created = await fetch(`${platform.origin}/api/slates`, {
			body: "{}",
			headers,
			method: "POST",
		})
		expect(created.status, await created.clone().text()).toBe(201)
		const slate = slateSchema.parse(await created.json())
		const { ARTIFACTS, DATABASES, AGENTS } = await platform.worker.getEnv()
		onCleanup(async () => {
			await ARTIFACTS.delete(slate.id)
		})
		await createSlateProject(resolve(import.meta.dirname, "../../.."), directory)
		await mkdir(join(directory, "agents/daily/schedules"), { recursive: true })
		await writeFile(
			join(directory, "public/slate.json"),
			JSON.stringify({ connections: {} }),
		)
		await writeFile(
			join(directory, "agents/daily/slate.json"),
			JSON.stringify({
				connections: {},
				databases: { inbox: { mode: "viewer" } },
				secrets: Object.fromEntries(names.map((name) => [name, { mode: "viewer" }])),
			}),
		)
		await writeFile(
			join(directory, "agents/daily/instructions.md"),
			"Save a personal update.\n",
		)
		await writeFile(
			join(directory, "agents/daily/schedules/daily.md"),
			'---\ncron: "0 0 1 1 *"\n---\nSave a personal update.\n',
		)
		await writeDatabase(directory, "inbox")
		const execute = execa({
			cwd: directory,
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
		await git("config", "user.name", "Secret setup test")
		await git("config", "user.email", "secret-setup-test@example.com")
		await git("remote", "add", "origin", `${platform.origin}/git/${slate.id}`)
		await git("add", ".")
		await git(
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-m",
			"Declare agent-only personal secrets",
		)
		await git("push", "origin", "main")
		const chromeUrl = new URL(`/dashboard/chrome/slates/${slate.id}`, platform.origin)
		chromeUrl.searchParams.set("parentOrigin", `https://${slate.public_hostname}`)
		const chromeHeaders = new Headers(webSession.headers)
		chromeHeaders.set("origin", platform.origin)
		chromeHeaders.set("accept", "text/html")
		const listing = await fetch(
			`${platform.origin}/api/slates/${slate.id}/resources/list`,
			{
				body: "{}",
				headers,
				method: "POST",
			},
		)
		expect(listing.status).toBe(200)
		const { resources } = slateResourcesSchema.parse(await listing.json())
		const inbox = resources.databases.inbox
		assert(inbox)
		return {
			chromeHeaders,
			chromeUrl,
			headers,
			inbox: DATABASES.getByName(inbox.instance_name),
			instance: await getAgentByName(
				AGENTS,
				getAgentInstanceName(slate.id, "daily", { id: webSession.user.id, type: "user" }),
			),
			members: () =>
				db
					.selectFrom("slate_member")
					.select("user_id")
					.where("slate_id", "=", slate.id)
					.execute(),
			slate,
		}
	},
)

test("non-writing: chrome lists agent-only personal secrets and rejects invalid and undeclared saves", {
	timeout: 180_000,
}, async ({ platform, secretSlate }) => {
	const { chromeHeaders, chromeUrl, headers, instance, members, slate } = secretSlate
	const chrome = await fetch(chromeUrl, { headers: chromeHeaders })
	expect(chrome.status).toBe(200)
	const html = await chrome.text()
	for (const name of names) expect(html).toContain(name)
	expect(html).toContain("2 inputs to configure")
	const invalid = await fetch(chromeUrl, {
		body: new URLSearchParams({ intent: "set-secret", name: names[0], value: "" }),
		headers: chromeHeaders,
		method: "POST",
	})
	expect(invalid.status).toBe(400)
	const undeclared = await fetch(
		`${platform.origin}/api/slates/${slate.id}/secrets/NOT_DECLARED`,
		{
			body: JSON.stringify({ value: "synthetic-not-saved" }),
			headers,
			method: "PUT",
		},
	)
	expect(undeclared.status).toBe(404)
	const schema = z
		.object({ paths: z.record(z.string(), z.unknown()) })
		.parse(await (await fetch(`${platform.origin}/api/openapi.json`)).json())
	expect(schema.paths["/slates/{target}/secrets/{name}"]).toEqual(
		expect.objectContaining({
			put: expect.objectContaining({ operationId: "setSlateSecret" }),
		}),
	)
	expect(await members()).toEqual([])
	expect(await instance.listSchedules()).toEqual([])
})

// These are real vault writes. An interrupted process can leave keys despite the cleanup below.
test("live Doppler: API partial save and chrome final secret enable agent-only resources", {
	timeout: 180_000,
}, async ({ platform, secretSlate, webSession }) => {
	const { chromeHeaders, chromeUrl, headers, inbox, instance, members, slate } =
		secretSlate
	const owner = { id: webSession.user.id, type: "personal" } as const
	const vault = parseSharedSecretsEnv(platform.env)
	const secretNames = await listSharedSecretNames(platform.env)
	for (const name of names) expect(secretNames.has(secretKey(owner, name))).toBe(false)
	await using cleanup = new AsyncDisposableStack()
	const values = [
		"synthetic-slate-primary-value",
		"synthetic-slate-secondary-value",
	] as const
	for (const [index, name] of names.entries()) {
		const value = values[index]
		assert(value)
		cleanup.defer(async () => {
			const dropped = await fetch(
				`${platform.origin}/api/secrets/personal/${encodeURIComponent(owner.id)}/${name}`,
				{
					headers,
					method: "DELETE",
				},
			)
			expect(dropped.status).toBe(200)
			expect(
				(await listSharedSecretNames(platform.env)).has(secretKey(owner, name)),
			).toBe(false)
		})
		const saved =
			index === 0
				? await fetch(`${platform.origin}/api/slates/${slate.id}/secrets/${name}`, {
						body: JSON.stringify({ value }),
						headers,
						method: "PUT",
					})
				: await fetch(chromeUrl, {
						body: new URLSearchParams({ intent: "set-secret", name, value }),
						headers: chromeHeaders,
						method: "POST",
					})
		expect(saved.status).toBe(200)
		const output = await saved.text()
		for (const secretValue of values) expect(output.includes(secretValue)).toBe(false)
		if (index === 0) expect(JSON.parse(output)).toEqual({ name, owner })
		expect((await loadSharedSecret(platform.env, owner, name)) === value).toBe(true)
		if (index === 0) {
			expect(await members()).toEqual([])
			expect(await instance.listSchedules()).toEqual([])
			await expect(inbox.query("SELECT * FROM updates")).rejects.toThrow()
		} else {
			expect(output).toContain("Setup complete")
			expect(await members()).toEqual([{ user_id: owner.id }])
			await expect
				.poll(() => instance.listSchedules(), { interval: 1000, timeout: 900_000 })
				.toHaveLength(1)
			expect((await inbox.query("SELECT * FROM updates")).rows).toEqual([])
		}
	}
	const logs = JSON.stringify(platform.harness.getLogs())
	for (const value of values) expect(logs.includes(value)).toBe(false)
	expect(logs.includes(vault.CTX_OWNER_CREDENTIALS_DOPPLER_TOKEN)).toBe(false)
})
