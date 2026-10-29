import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { test as base } from "@tests/integration"
import { createSlateProject } from "@usecontextlayer/dev-env/slate"
import { getAgentByName } from "agents/routing"
import { execa } from "execa"
import { expect } from "vitest"
import { getAgentInstanceName } from "@/agent-instance"
import { slateSchema } from "@/slates.schema"

export const test = base.extend(
	"secretSlate",
	async ({ db, directory, platform, webSession }, { onCleanup }) => {
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
		const { ARTIFACTS, AGENTS } = await platform.worker.getEnv()
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
		return {
			chromeHeaders,
			chromeUrl,
			headers,
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
			names,
			slate,
		}
	},
)
