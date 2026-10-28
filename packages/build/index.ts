import {
	WorkerEntrypoint,
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers"
import {
	CIWorkflow,
	type CiContext,
	type CiParams,
	type CloudflareArtifacts,
} from "@cloudflare/ci"
import { CiSandbox } from "@cloudflare/ci/worker"
import { databaseStatementSchema } from "@usecontextlayer/shared/databases"
import type { SlateProvisioning } from "@usecontextlayer/shared/slate-provisioning"
import { artifactTransferEnv } from "@/artifact"
import type { BuildBindings } from "@/env"
import { inspectCloudflare } from "@/inspection"
import { publishSlate } from "@/publish"
import { migrateSlateDatabases } from "@/slate-database-migrations"

export { CiSandbox, ContainerProxy } from "@cloudflare/ci/worker"

export default {} satisfies ExportedHandler<BuildBindings>

export class Inspection extends WorkerEntrypoint<BuildBindings> {
	fetch(request: Request) {
		return inspectCloudflare(this.env, request)
	}
}

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
				'pnpm install --frozen-lockfile && pnpm build && /usr/local/bin/rclone copy ./build "$CTX_BUILD_ARTIFACT_PATH" --config /dev/null',
			env: await artifactTransferEnv(this.env, event.instanceId, "object-read-write"),
			name: "build",
		})
		await migrateSlateDatabases(this.env, step, prepared, build.snapshot)
		await step.do(
			"deploy",
			{
				retries: { backoff: "linear", delay: "30 seconds", limit: 2 },
				timeout: "15 minutes",
			},
			() =>
				publishSlate(this.env, event.payload.repo, event.instanceId, event.payload.sha),
		)
		await step.do("provision slate schedules", () =>
			this.env.PROVISIONING.provisionSchedules(prepared),
		)
	}
}

export class ProvisionSlateMember extends WorkflowEntrypoint<
	BuildBindings,
	SlateProvisioning
> {
	async run(event: WorkflowEvent<SlateProvisioning>, step: WorkflowStep) {
		await migrateSlateDatabases(this.env, step, event.payload)
		await step.do("provision slate schedules", () =>
			this.env.PROVISIONING.provisionSchedules(event.payload),
		)
	}
}
