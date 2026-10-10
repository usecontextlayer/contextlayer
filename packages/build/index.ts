import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"
import {
	CIWorkflow,
	type CiContext,
	type CiParams,
	type CloudflareArtifacts,
} from "@cloudflare/ci"

export { CiSandbox } from "@cloudflare/ci/worker"

type BuildBindings = ConstructorParameters<typeof CIWorkflow>[1] & {
	PROVISIONING: { provision(slateId: string): Promise<void> }
}

export default {} satisfies ExportedHandler<BuildBindings>

export class Build extends CIWorkflow<CloudflareArtifacts, BuildBindings> {
	protected async pipeline(
		event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
		step: WorkflowStep,
		ci: CiContext,
	): Promise<void> {
		if (event.payload.branch !== "main") return
		const build = await ci.runner({
			command: "pnpm install --frozen-lockfile && pnpm build",
			name: "build",
		})
		await build.runner({
			cloudflareCredentials: true,
			command:
				'pnpm exec wrangler deploy --name "$CTX_SLATE_ID" --dispatch-namespace contextlayer-prod',
			env: { CTX_SLATE_ID: event.payload.repo },
			name: "deploy",
		})
		await step.do("provision slate", async () => {
			await this.env.PROVISIONING.provision(event.payload.repo)
		})
	}
}
