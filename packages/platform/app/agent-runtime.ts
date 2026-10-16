import { createAnthropic } from "@ai-sdk/anthropic"
import { Think, type ThinkSubmissionInspection, type TurnConfig } from "@cloudflare/think"
import { databaseQuerySchema } from "@usecontextlayer/shared/databases"
import { ownerSchema } from "@usecontextlayer/shared/slate-usage"
import { type ToolSet, tool } from "ai"
import { z } from "zod"
import {
	type AgentActor,
	type AgentJobSummary,
	type AgentRun,
	type AgentSchedule,
	agentRunSchema,
	type ScheduledAgentRun,
	scheduledAgentRunSchema,
} from "@/agents.schema"
import { getAgentRun } from "@/agents.server"
import { createConnectionSession } from "@/connections.server"
import type { PlatformEnv } from "@/context"
import { createPlatformDb } from "@/database"
import type { SlateId } from "@/database/models/public/Slate"
import { parsePlatformEnv } from "@/env"
import { loadSharedSecret } from "@/secrets.server"
import { slateSchema } from "@/slates.schema"

export class SlateAgent extends Think<PlatformEnv["Bindings"]> {
	maxSteps = 20
	workspaceBash = false
	waitForMcpConnections = true

	private get container() {
		const container = this.ctx.container
		if (!container) throw new Error("SlateAgent container binding is not configured")
		return container
	}

	getSystemPrompt() {
		return [
			super.getSystemPrompt(),
			"You run tasks for ContextLayer slates. Use bash to run real Linux commands and work with files in your sandbox. Use database_query with a declared database slug and parameterized SQL to query and save persistent data. Call PRAGMA table_info or inspect sqlite_master to discover its schema. Database writes persist immediately and are shared with the app and other jobs using that resource. Files in the sandbox are scratch space. Never print credentials or put them in your documents or messages.",
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
					if (!database) throw new Error("not-declared")
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

	async start(input: AgentRun, source: AgentJobSummary["source"]) {
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
		return this.summarizeSubmission(submission)
	}

	async provisionSchedules(
		slateId: SlateId,
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
				name,
				prompt: schedule.prompt,
				schedule: schedule.name,
				slateId,
			})
		}
	}

	async runScheduled(input: ScheduledAgentRun) {
		const scheduled = scheduledAgentRunSchema.parse(input)
		const config = parsePlatformEnv(this.env)
		const db = createPlatformDb(config.CTX_PLATFORM_DATABASE_URL)
		try {
			const slate = slateSchema.parse(
				await db
					.selectFrom("slate")
					.selectAll()
					.where("id", "=", scheduled.slateId)
					.executeTakeFirstOrThrow(),
			)
			const prepared = await getAgentRun(
				db,
				this.env.ARTIFACTS,
				this.env.DATABASES,
				this.env.AGENTS,
				config,
				slate,
				scheduled.actor,
				scheduled,
			)
			if (!prepared.allowed) {
				if (prepared.reason === "agent-definition-missing") {
					await this.provisionSchedules(
						scheduled.slateId,
						scheduled.name,
						scheduled.actor,
						[],
					)
					return
				}
				throw new Error(
					prepared.reason === "secret-required"
						? `secret-required: ${prepared.name}`
						: prepared.reason === "connection-required"
							? `connection-required: ${prepared.slug}`
							: prepared.reason,
				)
			}
			await this.start(prepared.run, "schedule")
		} finally {
			await db.destroy()
		}
	}

	private summarizeSubmission(submission: ThinkSubmissionInspection) {
		return {
			completed_at: submission.completedAt,
			created_at: submission.createdAt,
			error: submission.error,
			id: submission.submissionId,
			instance_name: this.name,
			source: submission.metadata?.source,
			started_at: submission.startedAt,
			status: submission.status,
		}
	}

	async listJobs(slateId: SlateId, name: string) {
		const submissions = await this.listSubmissions()
		if (submissions.length === 0) return []
		const run = agentRunSchema.parse(this.getConfig())
		if (run.slateId !== slateId || run.agent.name !== name) return []
		return submissions.map((submission) => this.summarizeSubmission(submission))
	}

	async inspect(slateId: SlateId, name: string, id: string) {
		const submission = await this.inspectSubmission(id)
		if (!submission) return null
		const run = agentRunSchema.parse(this.getConfig())
		if (run.slateId !== slateId || run.agent.name !== name) return null
		const message = submission.messageId
			? await this.session.getMessage(submission.messageId)
			: null
		return { ...this.summarizeSubmission(submission), message }
	}
}
