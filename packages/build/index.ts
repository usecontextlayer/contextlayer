import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"
import {
	CIWorkflow,
	type CiContext,
	type CiParams,
	type CloudflareArtifacts,
} from "@cloudflare/ci"
import { CiSandbox } from "@cloudflare/ci/worker"
import { databaseStatementSchema } from "@usecontextlayer/shared/databases"
import { signArtifactUrl } from "@/artifact"
import type { BuildBindings } from "@/env"
import { publishSlate } from "@/publish"

export { CiSandbox, ContainerProxy } from "@cloudflare/ci/worker"

export default {} satisfies ExportedHandler<BuildBindings>

CiSandbox.outboundHandlers = { database: queryDatabase }

async function queryDatabase(
	request: Request,
	env: BuildBindings,
	{
		params,
	}: Parameters<NonNullable<typeof CiSandbox.outboundHandlers>[string]>[2] & {
		params: { instanceName: string }
	},
): Promise<Response> {
	const statement = databaseStatementSchema.safeParse(await request.json())
	if (!statement.success) {
		return Response.json({ error: statement.error.message }, { status: 400 })
	}
	try {
		return Response.json(
			await env.DATABASES.getByName(params.instanceName).query(
				statement.data.sql,
				statement.data.params,
			),
		)
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 500 },
		)
	}
}

export class Build extends CIWorkflow<CloudflareArtifacts, BuildBindings> {
	protected async pipeline(
		event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
		step: WorkflowStep,
		ci: CiContext,
	): Promise<void> {
		if (event.payload.branch !== "main") return
		const prepared = await step.do("prepare slate", () =>
			this.env.PROVISIONING.prepare(event.payload.repo, event.payload.sha),
		)
		const build = await ci.runner({
			command:
				'pnpm install --frozen-lockfile && pnpm build && tar -czf /tmp/slate-build.tar.gz build/server build/client && curl --fail --silent --show-error --request PUT --upload-file /tmp/slate-build.tar.gz "$CTX_BUILD_ARTIFACT_URL"',
			env: {
				CTX_BUILD_ARTIFACT_URL: await signArtifactUrl(this.env, event.instanceId, "PUT"),
			},
			name: "build",
		})
		await step.do(
			"migrate slate databases",
			{ retries: { delay: "1 second", limit: 0 }, timeout: "1 hour" },
			() => this.env.PROVISIONING.migrate(prepared, build.snapshot),
		)
		await step.do(
			"deploy",
			{
				retries: { backoff: "linear", delay: "30 seconds", limit: 2 },
				timeout: "15 minutes",
			},
			() => publishSlate(this.env, event.payload.repo, event.instanceId),
		)
		await step.do("provision slate schedules", () =>
			this.env.PROVISIONING.provisionSchedules(prepared),
		)
	}
}
