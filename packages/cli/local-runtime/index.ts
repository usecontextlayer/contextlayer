import { WorkerEntrypoint } from "cloudflare:workers"
import { OpenAPIHono } from "@hono/zod-openapi"
import {
	getAgentByName,
	getAgentInstanceName,
} from "@usecontextlayer/shared/agent-routing"
import { agentScheduleSchema } from "@usecontextlayer/shared/agents"
import { parseSkillFrontmatter } from "agents/skills"
import { createLocalApi } from "@/local-runtime/api"
import { type LocalBindings, readSnapshot } from "@/local-runtime/env"

export { SlateAgentJob } from "@usecontextlayer/shared/agent-job"
export { SlateAgent } from "@usecontextlayer/shared/agent-runtime"
export {
	LocalDatabases as Databases,
	SlateDatabase,
} from "@usecontextlayer/shared/database-worker"
export { Meridian } from "@usecontextlayer/shared/meridian"
export {
	AgentPreparation,
	AgentResources,
	AppDatabases,
	MeridianProfiles,
	Tools,
} from "@/local-runtime/resources"

export class Provisioning extends WorkerEntrypoint<LocalBindings> {
	async provision() {
		const snapshot = readSnapshot(this.env)
		const definitions = Object.entries(snapshot.agents).map(([name, definition]) => ({
			name,
			schedules: Object.entries(definition.schedules).map(([name, source]) => {
				const { data, body } = parseSkillFrontmatter(source)
				return agentScheduleSchema.parse({ cron: data.cron, name, prompt: body })
			}),
		}))
		for (const { name, schedules } of definitions) {
			const actor = { type: "app" } as const
			const agent = await getAgentByName(
				this.env.AGENTS,
				getAgentInstanceName(snapshot.scope, name, actor),
			)
			await agent.provisionSchedules(snapshot.scope, name, actor, schedules)
		}
	}
}

const app = new OpenAPIHono<{ Bindings: LocalBindings }>()
app.route("/api", createLocalApi())
app.post("/__ctx/provision", async (c) => {
	await (
		c.executionCtx.exports as { Provisioning: Pick<Provisioning, "provision"> }
	).Provisioning.provision()
	return c.body(null, 204)
})
export default app
