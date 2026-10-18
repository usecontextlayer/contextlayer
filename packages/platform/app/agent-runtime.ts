import assert from "node:assert/strict"
import { Agent, type Schedule } from "agents"
import type { PiReceipt } from "agents/harness/pi"
import { type RoutedAgentEntry, RoutedAgents } from "agents/routing"
import type { SlateAgentJob } from "@/agent-job"
import {
	type AgentActor,
	type AgentJobMetadata,
	type AgentJobTrigger,
	type AgentRun,
	type AgentSchedule,
	type ScheduledAgentRun,
	scheduledAgentRunSchema,
} from "@/agents.schema"
import { getAgentRun } from "@/agents.server"
import type { PlatformEnv } from "@/context"
import { createPlatformDb } from "@/database"
import type { SlateId } from "@/database/models/public/Slate"
import { parsePlatformEnv } from "@/env"
import { slateSchema } from "@/slates.schema"

export class SlateAgent extends Agent<PlatformEnv["Bindings"]> {
	private jobs = new RoutedAgents<SlateAgentJob, AgentJobMetadata>({
		namespace: this.env.AGENT_JOBS,
		route: "jobs",
	})

	constructor(ctx: DurableObjectState, env: PlatformEnv["Bindings"]) {
		super(ctx, env)
		this.lifecycle.use(this.jobs)
	}

	async start(
		run: AgentRun,
		trigger: AgentJobTrigger,
	): Promise<{ job: RoutedAgentEntry<AgentJobMetadata>; receipt: PiReceipt }> {
		return this.ctx.blockConcurrencyWhile(async () => {
			const entry = await this.jobs.create({ metadata: { actor: run.actor, trigger } })
			const job = await this.jobs.get(entry.id)
			assert(job)
			return { job: entry, receipt: await job.start(run) }
		})
	}

	async listJobs() {
		return this.jobs.list()
	}

	async getJob(id: string) {
		return (await this.jobs.list()).find((job) => job.id === id) ?? null
	}

	async resolveJob(id: string): Promise<Omit<SlateAgentJob, keyof Agent> | null> {
		return this.jobs.get(id)
	}

	async deleteJob(id: string) {
		return this.jobs.delete(id)
	}

	async listAuthoredSchedules() {
		return (await this.listSchedules()).filter(
			(schedule) => schedule.callback === "runScheduled",
		)
	}

	async getAuthoredSchedule(id: string) {
		const schedule = await this.getScheduleById(id)
		return schedule?.callback === "runScheduled" ? schedule : null
	}

	async provisionSchedules(
		slateId: SlateId,
		name: string,
		actor: AgentActor,
		schedules: AgentSchedule[],
	) {
		for (const schedule of await this.listAuthoredSchedules()) {
			await this.cancelSchedule(schedule.id)
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

	async runScheduled(input: ScheduledAgentRun, schedule: Schedule<ScheduledAgentRun>) {
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
			await this.start(prepared.run, {
				schedule: scheduled.schedule,
				scheduleId: schedule.id,
				type: "schedule",
			})
		} finally {
			await db.destroy()
		}
	}
}
