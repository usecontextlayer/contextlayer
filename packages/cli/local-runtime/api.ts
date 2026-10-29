import { OpenAPIHono } from "@hono/zod-openapi"
import * as operations from "@usecontextlayer/shared/agent-operations"
import {
	getAgentByName,
	getAgentInstanceName,
} from "@usecontextlayer/shared/agent-routing"
import * as routes from "@usecontextlayer/shared/agents-api"
import { type LocalBindings, readSnapshot } from "@/local-runtime/env"
import { prepareLocalAgentRun } from "@/local-runtime/preparation"

async function scopes(env: LocalBindings, name: string) {
	return [
		await getAgentByName(
			env.AGENTS,
			getAgentInstanceName(readSnapshot(env).scope, name, { type: "app" }),
		),
	]
}

export function createLocalApi() {
	const api = new OpenAPIHono<{ Bindings: LocalBindings }>()
	api.use("/slates/:target/*", async (c, next) => {
		const snapshot = readSnapshot(c.env)
		const target = c.req.param("target")
		if (!["local", snapshot.scope, snapshot.gateway?.slateId].includes(target))
			return c.body(null, 404)
		await next()
	})
	const agents = new OpenAPIHono<{ Bindings: LocalBindings }>()
	agents.openapi(routes.getAgentRoute, async (c) => {
		const snapshot = readSnapshot(c.env)
		const name = c.req.valid("param").name
		const agent = Object.entries(snapshot.agents).find(([key]) => key === name)?.[1]
		if (!agent) return c.body(null, 404)
		return c.json({ commit: snapshot.source, instructions: agent.instructions }, 200)
	})
	agents.openapi(routes.listAgentSchedulesRoute, async (c) => {
		const result = await operations.listAgentSchedules(
			await scopes(c.env, c.req.valid("param").name),
		)
		return c.json(result.schedules, 200)
	})
	agents.openapi(routes.getAgentScheduleRoute, async (c) => {
		const { name, scheduleId } = c.req.valid("param")
		const result = await operations.getAgentSchedule(
			await scopes(c.env, name),
			scheduleId,
		)
		return result.schedule ? c.json(result.schedule, 200) : c.body(null, 404)
	})
	const jobs = new OpenAPIHono<{ Bindings: LocalBindings }>()
	jobs.openapi(routes.startAgentJobRoute, async (c) => {
		const prepared = prepareLocalAgentRun(
			readSnapshot(c.env),
			c.req.valid("param").name,
			c.req.valid("json").prompt,
		)
		if (!prepared.allowed) {
			if (prepared.reason === "secret-required")
				return c.json({ name: prepared.name, reason: prepared.reason }, 409)
			if (prepared.reason === "connection-required")
				return c.json({ reason: prepared.reason, slug: prepared.slug }, 409)
			return c.body(null, 404)
		}
		const creation = await operations.startAgentRun(c.env.AGENTS, prepared.run)
		c.header(
			"Location",
			`${new URL(c.req.url).pathname.replace(/\/$/, "")}/${creation.job.id}`,
		)
		return c.json(creation, 202)
	})
	jobs.openapi(routes.listAgentJobsRoute, async (c) => {
		return c.json(
			{
				jobs: await operations.listAgentJobs(
					await scopes(c.env, c.req.valid("param").name),
					c.req.valid("query").schedule,
				),
			},
			200,
		)
	})
	jobs.openapi(routes.getAgentJobRoute, async (c) => {
		const { name, id } = c.req.valid("param")
		const job = await operations.getAgentJob(await scopes(c.env, name), id)
		return job ? c.json(job, 200) : c.body(null, 404)
	})
	jobs.openapi(routes.getAgentJobOperationRoute, async (c) => {
		const { name, id } = c.req.valid("param")
		const operation = await operations.getAgentJobOperation(await scopes(c.env, name), id)
		return operation ? c.json(operation, 200) : c.body(null, 404)
	})
	jobs.openapi(routes.getAgentJobResultRoute, async (c) => {
		const { name, id } = c.req.valid("param")
		const operation = await operations.getAgentJobResult(await scopes(c.env, name), id)
		return operation ? c.json(operation, 200) : c.body(null, 404)
	})
	jobs.openapi(routes.listAgentJobSessionsRoute, async (c) => {
		const { name, id } = c.req.valid("param")
		const result = await operations.listAgentJobSessions(await scopes(c.env, name), id)
		return result.allowed ? c.json(result.sessions, 200) : c.body(null, 404)
	})
	jobs.openapi(routes.getAgentJobMessagesRoute, async (c) => {
		const { name, id, session } = c.req.valid("param")
		const result = await operations.getAgentJobMessages(
			await scopes(c.env, name),
			id,
			session,
		)
		return result.allowed ? c.json(result.messages, 200) : c.body(null, 404)
	})
	jobs.openapi(routes.getAgentJobUsageRoute, async (c) => {
		const { name, id } = c.req.valid("param")
		const result = await operations.getAgentJobUsage(await scopes(c.env, name), id)
		return result.allowed ? c.json(result.usage, 200) : c.body(null, 404)
	})
	jobs.openapi(routes.getAgentJobInspectionRoute, async (c) => {
		const { name, id } = c.req.valid("param")
		const result = await operations.getAgentJobInspection(await scopes(c.env, name), id)
		return result.allowed ? c.json(result.inspection, 200) : c.body(null, 404)
	})
	jobs.openapi(routes.abortAgentJobRoute, async (c) => {
		const { name, id } = c.req.valid("param")
		const result = await operations.abortAgentJob(await scopes(c.env, name), id)
		return result.allowed ? c.json(result.result, 200) : c.body(null, 404)
	})
	jobs.openapi(routes.deleteAgentJobRoute, async (c) => {
		const { name, id } = c.req.valid("param")
		const result = await operations.deleteAgentJob(await scopes(c.env, name), id)
		return c.body(null, result.allowed ? 204 : 404)
	})
	agents.route("/jobs", jobs)
	api.route("/slates/:target/agents/:name", agents)
	api.doc31("/openapi.json", {
		info: { title: "ContextLayer local slate", version: "1" },
		openapi: "3.1.0",
		servers: [{ url: "/api" }],
	})
	return api
}
