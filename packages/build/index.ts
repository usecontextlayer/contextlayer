import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"
import {
	CIWorkflow,
	type CiContext,
	type CiParams,
	type CloudflareArtifacts,
} from "@cloudflare/ci"

export { CiSandbox } from "@cloudflare/ci/worker"

type BuildBindings = ConstructorParameters<typeof CIWorkflow>[1] & {
	PUBLICATION: { publish(appId: string): Promise<void> }
}

export default {} satisfies ExportedHandler<BuildBindings>

export class Build extends CIWorkflow<CloudflareArtifacts, BuildBindings> {
	protected async pipeline(
		event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
		step: WorkflowStep,
		ci: CiContext,
	): Promise<void> {
		const build = await ci.runner({
			command: "pnpm install --frozen-lockfile && pnpm build",
			name: "build",
		})
		await build.runner({
			cloudflareCredentials: true,
			command:
				'pnpm exec wrangler deploy --name "$CTX_APP_ID" --dispatch-namespace contextlayer-prod',
			env: { CTX_APP_ID: event.payload.repo },
			name: "deploy",
		})
		await step.do("publish agent schedules", async () => {
			await this.env.PUBLICATION.publish(event.payload.repo)
		})
	}
}
