import { createAnthropic } from "@ai-sdk/anthropic"
import { Think, type TurnConfig } from "@cloudflare/think"
import { ownerSchema } from "@usecontextlayer/shared/app-usage"
import { databaseQuerySchema } from "@usecontextlayer/shared/databases"
import { type ToolSet, tool } from "ai"
import { z } from "zod"
import {
	type AgentActor,
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
			"You run tasks for ContextLayer apps. Use bash to run real Linux commands and work with files in your sandbox. Use database_query with a declared database slug and parameterized SQL to query and save persistent data. Call PRAGMA table_info or inspect sqlite_master to discover its schema. Database writes persist immediately and are shared with the app and other jobs using that resource. Files in the sandbox are scratch space. Never print credentials or put them in your documents or messages.",
			agentRunSchema.parse(this.getConfig()).agent.instructions,
		].join("\n\n")
	}

	async beforeTurn(): Promise<TurnConfig> {
		await this.prepareSandbox()
		const run = agentRunSchema.parse(this.getConfig())
		const owner = ownerSchema.parse(run.secrets.ANTHROPIC_API_KEY)
		const apiKey = await loadSharedSecret(this.env, owner, "ANTHROPIC_API_KEY")
		return {
			activeTools: ["bash", "database_query", ...Object.keys(this.mcp.getAITools())],
			model: createAnthropic({ apiKey, headers: { "accept-encoding": "identity" } })(
				"claude-haiku-4-5",
			),
		}
	}

	getTools(): ToolSet {
		return {
			bash: tool({
				description:
					"Run a Bash command in the Linux sandbox, with /workspace as the scratch working directory. Save persistent data with database_query.",
				execute: async ({ command }) => {
					const process = await this.container.exec(
						["timeout", "--kill-after=5", "60", "bash", "-lc", command],
						{ cwd: "/workspace" },
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
			database_query: tool({
				description:
					"Execute parameterized SQL against a declared database. Read its schema with sqlite_master or PRAGMA table_info. Writes persist immediately.",
				execute: async ({ slug, sql, params }) => {
					const run = agentRunSchema.parse(this.getConfig())
					const database = run.databases[slug]
					if (!database) throw new Error(`No database requirement for "${slug}"`)
					return this.env.DATABASES.getByName(database.instance_name).query(sql, params)
				},
				inputSchema: databaseQuerySchema,
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
		}
		await container.setInactivityTimeout(10 * 60 * 1000)
		const setup = await container.exec(["mkdir", "-p", "/workspace"])
		if ((await setup.output()).exitCode !== 0)
			throw new Error("Agent scratch workspace setup failed")
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

	async registerSchedules(
		appId: AppId,
		name: string,
		actor: AgentActor,
		schedules: AgentSchedule[],
	) {
		for (const schedule of await this.listSchedules()) {
			if (schedule.callback === "runScheduled") await this.cancelSchedule(schedule.id)
		}
		for (const schedule of schedules) {
			await this.schedule(schedule.cron, "runScheduled", {
				actor,
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
				scheduled.actor,
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
