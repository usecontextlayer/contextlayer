import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test as base } from "@tests/integration"
import { copySlateProject } from "@usecontextlayer/dev-env/slate"
import { execa } from "execa"
import { expect } from "vitest"
import { getAgentInstanceName } from "@/agent-instance"
import type { SlateAgent } from "@/agent-runtime"
import { type Slate, slateSchema } from "@/slates.schema"

type SecretSlate = {
	chromeHeaders: Headers
	chromeUrl: URL
	headers: Headers
	instance: DurableObjectStub<SlateAgent>
	members: () => Promise<{ user_id: string }[]>
	names: readonly [string, string]
	slate: Slate
}

export const test = base.extend<{ secretSlate: SecretSlate }>({
	secretSlate: async ({ db, directory, platform, webSession }, use) => {
		await using resources = new AsyncDisposableStack()
		const { ARTIFACTS, AGENTS } = await platform.worker.getEnv()
		const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase()
		const names = [
			`CTX_SLATE_SETUP_E2E_${suffix}_PRIMARY`,
			`CTX_SLATE_SETUP_E2E_${suffix}_SECONDARY`,
		] as const
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
		resources.defer(async () => {
			await db.deleteFrom("slate").where("id", "=", slate.id).execute()
		})
		resources.defer(async () => {
			await ARTIFACTS.delete(slate.id)
		})
		await copySlateProject(directory)
		await mkdir(join(directory, "agents/daily/schedules"), { recursive: true })
		await writeFile(
			join(directory, "app/slate.json"),
			JSON.stringify({ connections: {} }),
		)
		await writeFile(
			join(directory, "agents/daily/slate.json"),
			JSON.stringify({
				connections: {},
				secrets: Object.fromEntries(names.map((name) => [name, { mode: "viewer" }])),
			}),
		)
		await writeFile(
			join(directory, "agents/daily/instructions.md"),
			"Use the configured personal secrets.\n",
		)
		await writeFile(
			join(directory, "agents/daily/schedules/daily.md"),
			'---\ncron: "0 0 1 1 *"\n---\nUse the configured personal secrets.\n',
		)
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
		await use({
			chromeHeaders,
			chromeUrl,
			headers,
			instance: AGENTS.getByName(
				getAgentInstanceName(slate.id, "daily", { id: webSession.user.id, type: "user" }),
			),
			members: () =>
				db
					.selectFrom("slate_member")
					.select("user_id")
					.where("slate_id", "=", slate.id)
					.execute(),
			names,
			slate,
		})
	},
})
