import { createAnthropic } from "@ai-sdk/anthropic"
import { Think, type TurnConfig } from "@cloudflare/think"
import { ownerSchema } from "@usecontextlayer/shared/app-usage"
import { type ToolSet, tool } from "ai"
import { z } from "zod"
import {
	type AgentJob,
	type AgentRun,
	type AgentSchedule,
	agentJobSchema,
	agentRunSchema,
	type ScheduledAgentRun,
	scheduledAgentRunSchema,
} from "@/agents.schema"
import { getAgentRun } from "@/agents.server"
import { appSchema } from "@/apps.schema"
import { createConnectionSession } from "@/connections.server"
import type { PlatformEnv } from "@/context"
import { createPlatformDb } from "@/database"
import type { AppId } from "@/database/models/public/App"
import { parseDatabaseEnv } from "@/env"
import { loadSharedSecret } from "@/secrets.server"

export const SHARED_ARTIFACTS_REPO = "agent-shared-2026-10-05-91fc24d8"

export class AppAgent extends Think<PlatformEnv["Bindings"]> {
	maxSteps = 20
	workspaceBash = false
	waitForMcpConnections = true

	private get container() {
		const container = this.ctx.container
		if (!container) throw new Error("AppAgent container binding is not configured")
		return container
	}

	getSystemPrompt() {
		return [
			super.getSystemPrompt(),
			"You run tasks for ContextLayer apps. Use bash to run real Linux commands and work with files in your sandbox. /shared is an Artifacts-backed Git working tree, already checked out from origin/main. Save work intended for subsequent jobs there. Local edits are not shared until committed and successfully pushed to origin/main. Push work you intend to preserve before finishing. Other paths are scratch space. Never print credentials or put them in your documents or messages.",
			agentRunSchema.parse(this.getConfig()).agent.instructions,
		].join("\n\n")
	}

	async beforeTurn(): Promise<TurnConfig> {
		await this.prepareSandbox()
		const run = agentRunSchema.parse(this.getConfig())
		const owner = ownerSchema.parse(run.secrets.ANTHROPIC_API_KEY)
		const apiKey = await loadSharedSecret(this.env, owner, "ANTHROPIC_API_KEY")
		return {
			activeTools: ["bash", ...Object.keys(this.mcp.getAITools())],
			model: createAnthropic({ apiKey, headers: { "accept-encoding": "identity" } })(
				"claude-haiku-4-5",
			),
		}
	}

	getTools(): ToolSet {
		return {
			bash: tool({
				description:
					"Run a Bash command in the Linux sandbox, with /shared as the working directory. Git is available; commit and push shared work to preserve it.",
				execute: async ({ command }) => {
					const process = await this.container.exec(
						["timeout", "--kill-after=5", "60", "bash", "-lc", command],
						{ cwd: "/shared" },
					)
					const output = await process.output()
					const decoder = new TextDecoder()
					return {
						exitCode: output.exitCode,
						stderr: decoder.decode(output.stderr).slice(-10_000),
						stdout: decoder.decode(output.stdout).slice(-10_000),
					}
				},
				inputSchema: z.object({ command: z.string() }),
			}),
		}
	}

	private async prepareSandbox() {
		const container = this.container
		if (!container.running) {
			container.start({
				enableInternet: true,
				entrypoint: ["sleep", "infinity"],
				image: container.images.base,
			})
			await container.setInactivityTimeout(10 * 60 * 1000)
			using repo = await this.env.ARTIFACTS.get(SHARED_ARTIFACTS_REPO)
			const info = await repo.info()
			const token = await repo.createToken("write", 3600)
			const remote = new URL(info.remote)
			remote.username = "x"
			remote.password = token.plaintext.replace(/\?expires=.*$/, "")
			const process = await container.exec(
				[
					"bash",
					"-ec",
					'umask 077; printf "%s\\n" "$ARTIFACTS_GIT_REMOTE" > /root/.git-credentials; git config --global credential.helper store; git clone --branch main "$ARTIFACTS_REMOTE" /shared; git -C /shared config user.name ContextLayer; git -C /shared config user.email agents@usecontextlayer.com',
				],
				{ env: { ARTIFACTS_GIT_REMOTE: remote.href, ARTIFACTS_REMOTE: info.remote } },
			)
			const output = await process.output()
			if (output.exitCode !== 0)
				throw new Error(`Artifacts checkout failed with exit code ${output.exitCode}`)
		}
		await container.setInactivityTimeout(10 * 60 * 1000)
	}

	async start(input: AgentRun, source: AgentJob["source"]): Promise<AgentJob> {
		const run = agentRunSchema.parse(input)
		await this.configure(run)
		for (const [slug, connection] of Object.entries(run.connections)) {
			const session = await createConnectionSession(
				this.env.COMPOSIO_API_KEY,
				connection.owner,
				connection.connection_id,
				connection.toolkit,
			)
			await this.addMcpServer(slug, session.mcp.url, {
				transport: { headers: session.mcp.headers },
			})
		}
		const submission = await this.submitMessages(
			[
				{
					id: crypto.randomUUID(),
					parts: [{ text: run.prompt, type: "text" }],
					role: "user",
				},
			],
			{ metadata: { source }, submissionId: crypto.randomUUID() },
		)
		return {
			id: submission.submissionId,
			instance_name: this.name,
			result: null,
			source,
			status: submission.status,
		}
	}

	async registerSchedules(appId: AppId, name: string, schedules: AgentSchedule[]) {
		for (const schedule of await this.listSchedules()) {
			if (schedule.callback === "runScheduled") await this.cancelSchedule(schedule.id)
		}
		for (const schedule of schedules) {
			await this.schedule(schedule.cron, "runScheduled", {
				appId,
				name,
				prompt: schedule.prompt,
				schedule: schedule.name,
			})
		}
	}

	async runScheduled(input: ScheduledAgentRun) {
		const scheduled = scheduledAgentRunSchema.parse(input)
		const config = parseDatabaseEnv(this.env)
		const db = createPlatformDb(config.CTX_PLATFORM_DATABASE_URL)
		try {
			const app = appSchema.parse(
				await db
					.selectFrom("app")
					.selectAll()
					.where("id", "=", scheduled.appId)
					.executeTakeFirstOrThrow(),
			)
			const prepared = await getAgentRun(
				db,
				this.env.ARTIFACTS,
				app,
				{ type: "app" },
				scheduled,
			)
			if (!prepared.allowed)
				throw new Error("Published scheduled agent or connection assignment not found")
			await this.start(prepared.run, "schedule")
		} finally {
			await db.destroy()
		}
	}

	async listJobs(appId: AppId, name: string): Promise<AgentJob[]> {
		const submissions = await this.listSubmissions()
		const jobs: AgentJob[] = []
		for (const submission of submissions) {
			const job = await this.inspect(appId, name, submission.submissionId)
			if (job) jobs.push(job)
		}
		return jobs
	}

	async inspect(appId: AppId, name: string, id: string): Promise<AgentJob | null> {
		const submission = await this.inspectSubmission(id)
		if (!submission) return null
		const run = agentRunSchema.parse(this.getConfig())
		if (run.appId !== appId || run.agent.name !== name) return null
		const message = submission.messageId
			? await this.session.getMessage(submission.messageId)
			: null
		return {
			error: submission.error,
			id: submission.submissionId,
			instance_name: this.name,
			result:
				message?.parts
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n") ?? null,
			source: agentJobSchema.shape.source.parse(submission.metadata?.source),
			status: submission.status,
		}
	}
}
