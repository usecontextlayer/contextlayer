import { z } from "zod"
import { getAgentByName, getAgentInstanceName } from "@/lib/agent-routing"
import type { SlateAgent } from "@/lib/agent-runtime"
import {
	type AgentJobTrigger,
	type AgentRun,
	agentJobInspectionSchema,
	agentJobMessageSchema,
	agentRuntimeScheduleSchema,
} from "@/lib/agents"

export async function startAgentRun(
	agents: DurableObjectNamespace<SlateAgent>,
	run: AgentRun,
	trigger: AgentJobTrigger = { type: "api" },
) {
	const agent = await getAgentByName(
		agents,
		getAgentInstanceName(run.slateId, run.agent.name, run.actor),
	)
	return agent.start(run, trigger)
}

export async function getAgentJob(
	scopes: readonly DurableObjectStub<SlateAgent>[],
	id: string,
) {
	for (const agent of scopes) {
		const job = await agent.getJob(id)
		if (job) return job
	}
	return null
}

async function resolveAgentJob(
	scopes: readonly DurableObjectStub<SlateAgent>[],
	id: string,
) {
	for (const agent of scopes) {
		const job = await agent.resolveJob(id)
		if (job) return job
	}
	return null
}

export async function getAgentJobOperation(
	scopes: readonly DurableObjectStub<SlateAgent>[],
	id: string,
) {
	using job = await resolveAgentJob(scopes, id)
	return job ? await job.operation() : null
}

export async function getAgentJobResult(
	scopes: readonly DurableObjectStub<SlateAgent>[],
	id: string,
) {
	using job = await resolveAgentJob(scopes, id)
	return job ? await job.result() : null
}

export async function listAgentJobs(
	scopes: readonly DurableObjectStub<SlateAgent>[],
	schedule?: string,
) {
	const jobs = await Promise.all(scopes.map((agent) => agent.listJobs()))
	return jobs
		.flat()
		.filter(
			(job) =>
				schedule === undefined ||
				(job.metadata?.trigger.type === "schedule" &&
					job.metadata.trigger.schedule === schedule),
		)
		.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
}

export async function listAgentJobSessions(
	scopes: readonly DurableObjectStub<SlateAgent>[],
	id: string,
) {
	using job = await resolveAgentJob(scopes, id)
	if (!job) return { allowed: false, reason: "not-found" } as const
	return { allowed: true, sessions: await job.listSessions() } as const
}

export async function getAgentJobMessages(
	scopes: readonly DurableObjectStub<SlateAgent>[],
	id: string,
	session: string,
) {
	using job = await resolveAgentJob(scopes, id)
	if (!job) return { allowed: false, reason: "not-found" } as const
	const messages = await job.messages(session)
	if (messages === null) return { allowed: false, reason: "not-found" } as const
	return {
		allowed: true,
		messages: z.array(agentJobMessageSchema).parse(messages),
	} as const
}

export async function getAgentJobUsage(
	scopes: readonly DurableObjectStub<SlateAgent>[],
	id: string,
) {
	using job = await resolveAgentJob(scopes, id)
	if (!job) return { allowed: false, reason: "not-found" } as const
	return { allowed: true, usage: await job.usage() } as const
}

export async function getAgentJobInspection(
	scopes: readonly DurableObjectStub<SlateAgent>[],
	id: string,
) {
	using job = await resolveAgentJob(scopes, id)
	if (!job) return { allowed: false, reason: "not-found" } as const
	return {
		allowed: true,
		inspection: agentJobInspectionSchema.parse(await job.inspection()),
	} as const
}

export async function abortAgentJob(
	scopes: readonly DurableObjectStub<SlateAgent>[],
	id: string,
) {
	using job = await resolveAgentJob(scopes, id)
	if (!job) return { allowed: false, reason: "not-found" } as const
	return { allowed: true, result: await job.abort() } as const
}

export async function deleteAgentJob(
	scopes: readonly DurableObjectStub<SlateAgent>[],
	id: string,
) {
	for (const agent of scopes) {
		if (await agent.deleteJob(id)) return { allowed: true } as const
	}
	return { allowed: false, reason: "not-found" } as const
}

export async function listAgentSchedules(
	scopes: readonly DurableObjectStub<SlateAgent>[],
) {
	const schedules = await Promise.all(
		scopes.map(async (agent) =>
			z.array(agentRuntimeScheduleSchema).parse(await agent.listAuthoredSchedules()),
		),
	)
	return { allowed: true, schedules: schedules.flat() } as const
}

export async function getAgentSchedule(
	scopes: readonly DurableObjectStub<SlateAgent>[],
	id: string,
) {
	for (const agent of scopes) {
		const schedule = await agent.getAuthoredSchedule(id)
		if (schedule)
			return {
				allowed: true,
				schedule: agentRuntimeScheduleSchema.parse(schedule),
			} as const
	}
	return { allowed: true, schedule: null } as const
}
