import assert from "node:assert/strict"
import { Agent, type Schedule } from "agents"
import type { PiReceipt } from "agents/harness/pi"
import { type RoutedAgentEntry, RoutedAgents } from "agents/routing"
import type { SlateAgentJob } from "@/lib/agent-job"
import type { AgentRuntimeExports } from "@/lib/agent-resources"
import {
	type AgentActor,
	type AgentJobMetadata,
	type AgentJobTrigger,
	type AgentRun,
	type AgentSchedule,
	type ScheduledAgentRun,
	scheduledAgentRunSchema,
} from "@/lib/agents"

export class SlateAgent extends Agent<{
	AGENT_JOBS: DurableObjectNamespace<SlateAgentJob>
}> {
	private jobs = new RoutedAgents<SlateAgentJob, AgentJobMetadata>({
		namespace: this.env.AGENT_JOBS,
		route: "jobs",
	})

	constructor(
		ctx: DurableObjectState,
		env: { AGENT_JOBS: DurableObjectNamespace<SlateAgentJob> },
	) {
		super(ctx, env)
		this.lifecycle.use(this.jobs)
	}

	async start(
		run: AgentRun,
		trigger: AgentJobTrigger,
	): Promise<{ job: RoutedAgentEntry<AgentJobMetadata>; receipt: PiReceipt }> {
		return this.ctx.blockConcurrencyWhile(async () => {
			const entry = await this.jobs.create({ metadata: { actor: run.actor, trigger } })
			try {
				const job = await this.jobs.get(entry.id)
				assert(job)
				return { job: entry, receipt: await job.start(run) }
			} catch (error) {
				await this.jobs.delete(entry.id)
				throw error
			}
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
		slateId: string,
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
		const prepared = await (
			this.ctx.exports as AgentRuntimeExports
		).AgentPreparation.prepare(scheduled)
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
	}
}
