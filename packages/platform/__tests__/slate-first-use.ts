import assert from "node:assert/strict"
import { join, resolve } from "node:path"
import { executionTest as base } from "@tests/integration"
import { createSlateProject } from "@usecontextlayer/dev-env/slate"
import { signInViewer } from "@usecontextlayer/dev-env/viewer"
import { execa } from "execa"
import { expect } from "vitest"
import type { WorkerHandle } from "wrangler"
import { slateSchema } from "@/slates.schema"

export const test = base.extend(
	"firstUseSlate",
	async (
		{ db, directory, execution, platform, serviceEnv, webSession },
		{ onCleanup },
	) => {
		const headers = new Headers(webSession.headers)
		headers.set("content-type", "application/json")
		headers.set("origin", platform.origin)
		const created = await fetch(`${platform.origin}/api/slates`, {
			body: "{}",
			headers,
			method: "POST",
		})
		expect(created.status, await created.clone().text()).toBe(201)
		const slate = slateSchema.parse(await created.json())
		const { ARTIFACTS } = await platform.worker.getEnv()
		onCleanup(async () => {
			await ARTIFACTS.delete(slate.id)
		})
		const checkout = join(directory, "first-use")
		await createSlateProject(resolve(import.meta.dirname, "../../.."), checkout)
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
		await git("config", "user.name", "Slate first-use test")
		await git("config", "user.email", "first-use@example.com")
		await git("remote", "add", "origin", `${platform.origin}/git/${slate.id}`)
		const viewerHeaders = await signInViewer({
			authURL: serviceEnv.addresses.CTX_VIEWER_AUTH_URL.origin,
			returnTo: `https://${slate.public_hostname}/`,
			webHeaders: webSession.headers,
		})
		const token = decodeURIComponent(
			viewerHeaders.get("cookie")?.match(/ctx-viewer-auth=([^;]+)/)?.[1] ?? "",
		)
		assert(token)
		const props = { credential: { token, type: "session" }, slateId: slate.id } as const
		return {
			checkout,
			headers,
			members: () =>
				db
					.selectFrom("slate_member")
					.select("user_id")
					.where("slate_id", "=", slate.id)
					.execute(),
			props,
			push: async (message: string) => {
				await git("add", ".")
				await git("-c", "commit.gpgsign=false", "commit", "-m", message)
				await git("push", "origin", "main")
			},
			query: (
				sql: string,
				params: (string | number | null)[] = [],
				slug = "drafts",
			): ReturnType<WorkerHandle["fetch"]> =>
				execution.worker.fetch("http://execution/databases", {
					body: JSON.stringify([props, [slug, sql, params]]),
					headers: { "content-type": "application/json" },
					method: "POST",
				}),
			slate,
		}
	},
)
