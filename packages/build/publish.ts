import { getSandbox } from "@cloudflare/sandbox"
import { artifactTransferEnv } from "@/artifact"
import type { BuildBindings } from "@/env"

export async function publishSlate(
	env: BuildBindings,
	slateId: string,
	instanceId: string,
	commit: string,
): Promise<void> {
	const sandbox = getSandbox(env.SANDBOX, `deploy-${crypto.randomUUID()}`, {
		enableDefaultSession: false,
		transport: "rpc",
	})
	try {
		const download = await sandbox.exec(
			'/usr/local/bin/rclone copy "$CTX_BUILD_ARTIFACT_PATH" /tmp/slate-deploy/payload --config /dev/null',
			{
				cwd: "/",
				env: await artifactTransferEnv(env, instanceId, "object-read-only"),
				timeout: 120_000,
			},
		)
		if (!download.success) {
			throw new Error(`Deployment artifact download failed: ${download.stderr}`)
		}
		const deployment = await sandbox.exec(
			'/opt/contextlayer/node_modules/.bin/wrangler deploy --no-bundle --no-autoconfig --name "$CTX_SLATE_ID" --tag "$CTX_BUILD_COMMIT" --dispatch-namespace "$CTX_DISPATCH_NAMESPACE"',
			{
				cwd: "/tmp/slate-deploy/payload",
				env: {
					CI: "true",
					CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
					CLOUDFLARE_API_TOKEN: env.CF_TOKEN,
					CTX_BUILD_COMMIT: commit,
					CTX_DISPATCH_NAMESPACE: env.CTX_DISPATCH_NAMESPACE,
					CTX_SLATE_ID: slateId,
					WRANGLER_SEND_METRICS: "false",
				},
				timeout: 600_000,
			},
		)
		console.log(deployment.stdout)
		if (!deployment.success) {
			throw new Error(`Slate deployment failed: ${deployment.stderr}`)
		}
	} finally {
		await sandbox.destroy()
	}
}
