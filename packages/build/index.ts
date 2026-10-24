import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"
import {
	CIWorkflow,
	type CiContext,
	type CiParams,
	type CloudflareArtifacts,
} from "@cloudflare/ci"
import { CiSandbox, type DirectoryBackup } from "@cloudflare/ci/worker"
import type { SlateDatabase } from "@usecontextlayer/shared/database-worker"
import { databaseStatementSchema } from "@usecontextlayer/shared/databases"
import type { SlateProvisioning } from "@usecontextlayer/shared/slate-provisioning"

export { CiSandbox, ContainerProxy } from "@cloudflare/ci/worker"

type BuildBindings = ConstructorParameters<typeof CIWorkflow>[1] & {
	DATABASES: DurableObjectNamespace<SlateDatabase>
	PROVISIONING: {
		prepare(slateId: string, commit: string): Promise<SlateProvisioning>
		migrate(prepared: SlateProvisioning, restore?: DirectoryBackup): Promise<void>
		provisionSchedules(prepared: SlateProvisioning): Promise<void>
	}
}

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
			command: "pnpm install --frozen-lockfile && pnpm build",
			name: "build",
		})
		await step.do(
			"migrate slate databases",
			{ retries: { delay: "1 second", limit: 0 }, timeout: "1 hour" },
			() => this.env.PROVISIONING.migrate(prepared, build.snapshot),
		)
		await build.runner({
			cloudflareCredentials: true,
			command:
				'pnpm exec wrangler deploy --name "$CTX_SLATE_ID" --dispatch-namespace contextlayer-prod',
			env: { CTX_SLATE_ID: event.payload.repo },
			name: "deploy",
		})
		await step.do("provision slate schedules", () =>
			this.env.PROVISIONING.provisionSchedules(prepared),
		)
	}
}
