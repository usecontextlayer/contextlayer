import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"
import {
	CIWorkflow,
	type CiContext,
	type CiParams,
	type CloudflareArtifacts,
} from "@cloudflare/ci"

export { CiSandbox } from "@cloudflare/ci/worker"

export class Build extends CIWorkflow {
	protected async pipeline(
		event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
		_step: WorkflowStep,
		ci: CiContext,
	): Promise<void> {
		const build = await ci.runner({
			command: "pnpm install --frozen-lockfile && pnpm build",
			name: "build",
		})
		await build.runner({
			cloudflareCredentials: true,
			command:
				'pnpm exec wrangler deploy --name "$CTX_APP_ID" --dispatch-namespace contextlayer-dev',
			env: { CTX_APP_ID: event.payload.repo },
			name: "deploy",
		})
	}
}
