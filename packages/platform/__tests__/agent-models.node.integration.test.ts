import { execFile as execFileCallback } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { AssistantEntry } from "@earendil-works/pi-durable"
import { test } from "@tests/integration"
import seed from "@usecontextlayer/dev-env/seed.json" with { type: "json" }
import { slateResourcesSchema } from "@usecontextlayer/shared/slate-resources"
import { expect } from "vitest"
import { z } from "zod"
import {
	agentJobCreationSchema,
	agentJobMessageSchema,
	agentJobResultSchema,
	agentJobUsageSchema,
} from "@/agents.schema"
import { organizationSchema } from "@/auth.server"
import { loadSharedSecret } from "@/secrets.server"
import { slateSchema } from "@/slates.schema"

const execFile = promisify(execFileCallback)

for (const mode of ["default", "owner", "viewer"] as const) {
	test(`API jobs record the ${mode} model selection`, async ({
		directory,
		platform,
		webEnv,
		webSession,
	}) => {
		const { origin, worker } = platform
		const headers = new Headers(webSession.headers)
		headers.set("origin", origin)
		headers.set("content-type", "application/json")
		const organizationsResponse = await fetch(
			`${webEnv.BETTER_AUTH_URL}/api/platform/organizations`,
			{ headers: webSession.headers },
		)
		expect(organizationsResponse.status).toBe(200)
		const organization = z
			.object({ organizations: z.array(organizationSchema) })
			.parse(await organizationsResponse.json())
			.organizations.find((item) => item.slug === seed.web.organization.slug)
		if (!organization) throw new Error("Initialize the DevEnv organization")
		const owner = { id: organization.id, type: "organization" } as const
		const viewer = { id: webSession.user.id, type: "personal" } as const
		let expectedModel = "claude-haiku-4-5"
		if (mode !== "default") {
			const [ownerModel, viewerModel] = await Promise.all([
				loadSharedSecret(platform.env, owner, "ANTHROPIC_MODEL"),
				loadSharedSecret(platform.env, viewer, "ANTHROPIC_MODEL"),
			])
			expect(ownerModel, "Configure distinct owner and viewer model IDs").not.toBe(
				viewerModel,
			)
			for (const model of [ownerModel, viewerModel])
				expect(
					model,
					"Configure owner and viewer models different from the default",
				).not.toBe(expectedModel)
			expectedModel = mode === "owner" ? ownerModel : viewerModel
		}
		const created = await fetch(`${origin}/api/slates`, {
			body: JSON.stringify({ organization_slug: organization.slug }),
			headers,
			method: "POST",
		})
		expect(created.status).toBe(201)
		const slate = slateSchema.parse(await created.json())
		const { ARTIFACTS } = await worker.getEnv()
		await using resources = new AsyncDisposableStack()
		resources.defer(async () => {
			const { ARTIFACTS } = await worker.getEnv()
			await ARTIFACTS.delete(slate.id)
		})
		const repo = await ARTIFACTS.get(slate.id)
		const { remote } = await repo.info()
		const token = await repo.createToken("write")
		await mkdir(join(directory, "agents/model"), { recursive: true })
		await mkdir(join(directory, "public"))
		await writeFile(
			join(directory, "public/slate.json"),
			JSON.stringify({ connections: {} }),
		)
		await writeFile(
			join(directory, "agents/model/slate.json"),
			JSON.stringify({
				connections: {},
				secrets: {
					ANTHROPIC_API_KEY: { mode: "owner" },
					...(mode === "default" ? {} : { ANTHROPIC_MODEL: { mode } }),
				},
			}),
		)
		await writeFile(
			join(directory, "agents/model/instructions.md"),
			"Answer briefly without using tools.\n",
		)
		const git = (...args: string[]) =>
			execFile("git", args, {
				cwd: directory,
				env: {
					...process.env,
					GIT_CONFIG_COUNT: "1",
					GIT_CONFIG_GLOBAL: join(directory, "gitconfig"),
					GIT_CONFIG_KEY_0: "http.extraHeader",
					GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token.plaintext}`,
					GIT_TERMINAL_PROMPT: "0",
				},
			})
		await git("init", "-b", "main")
		await git("config", "user.name", "Pi Model Acceptance")
		await git("config", "user.email", "pi-model-test@example.com")
		await git("add", "agents", "public")
		await git("-c", "commit.gpgsign=false", "commit", "-m", "Declare agent model")
		await git("push", remote, "main")
		const inventory = await fetch(`${origin}/api/slates/${slate.id}/resources/list`, {
			body: "{}",
			headers,
			method: "POST",
		})
		expect(inventory.status).toBe(200)
		const configured = slateResourcesSchema.parse(await inventory.json()).resources
		expect(configured.secrets.ANTHROPIC_API_KEY?.owner).toEqual(owner)
		if (mode === "default") expect(configured.secrets.ANTHROPIC_MODEL).toBeUndefined()
		else
			expect(configured.secrets.ANTHROPIC_MODEL?.owner).toEqual(
				mode === "owner" ? owner : viewer,
			)
		const url = `${origin}/api/slates/${slate.id}/agents/model/jobs`
		const submitted = await fetch(url, {
			body: JSON.stringify({ prompt: "Say hello in one sentence." }),
			headers,
			method: "POST",
		})
		expect(submitted.status).toBe(202)
		const api = agentJobCreationSchema.parse(await submitted.json())
		expect(api.job.metadata).toEqual({
			actor: { id: viewer.id, type: "user" },
			trigger: { type: "api" },
		})
		const completed = await fetch(`${url}/${api.job.id}/result`, { headers })
		expect(completed.status).toBe(200)
		const result = agentJobResultSchema.parse(await completed.json())
		expect(result.status, result.reason).toBe("done")
		const response = await fetch(
			`${url}/${api.job.id}/sessions/${result.session}/messages`,
			{ headers },
		)
		expect(response.status).toBe(200)
		const assistants = z
			.array(agentJobMessageSchema)
			.parse(await response.json())
			.filter((entry) => entry.kind === AssistantEntry.kind)
			.flatMap((entry) => entry.model ?? [])
			.filter((message) => message.role === "assistant")
		expect(assistants.length).toBeGreaterThan(0)
		for (const assistant of assistants)
			expect(assistant).toMatchObject({ model: expectedModel, provider: "anthropic" })
		const usageResponse = await fetch(`${url}/${api.job.id}/usage`, { headers })
		expect(usageResponse.status).toBe(200)
		const usage = agentJobUsageSchema.parse(await usageResponse.json())
		expect(Object.keys(usage.models)).toEqual([`anthropic/${expectedModel}`])
		const deleted = await fetch(`${url}/${api.job.id}`, { headers, method: "DELETE" })
		expect(deleted.status).toBe(204)
	}, 300_000)
}
