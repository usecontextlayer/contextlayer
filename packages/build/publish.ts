import { getSandbox } from "@cloudflare/sandbox"
import { artifactTransferEnv } from "@/artifact"
import { slateDeploymentConfig } from "@/deployment"
import type { BuildBindings } from "@/env"
import { redactSecrets } from "@/redaction"

export async function publishSlate(
	env: BuildBindings,
	slateId: string,
	instanceId: string,
	commit: string,
) {
	const sandbox = getSandbox(env.SANDBOX, `deploy-${crypto.randomUUID()}`, {
		enableDefaultSession: false,
		transport: "rpc",
	})
	try {
		const transfer = await artifactTransferEnv(env, instanceId, "object-read-only")
		const secrets = [env.CF_TOKEN, ...Object.values(transfer)]
		const download = await sandbox.exec(
			'/usr/local/bin/rclone copy "$CTX_BUILD_ARTIFACT_PATH" /tmp/slate-deploy/payload --config /dev/null',
			{
				cwd: "/",
				env: transfer,
				timeout: 120_000,
			},
		)
		if (!download.success) {
			throw new Error(
				`Deployment artifact download failed: ${redactSecrets(download.stderr, secrets)}`,
			)
		}
		await sandbox.writeFile("/tmp/slate-deploy/tsconfig.json", "{}")
		await sandbox.writeFile(
			"/tmp/slate-deploy/wrangler.json",
			JSON.stringify(slateDeploymentConfig(slateId, commit)),
		)
		const deployment = await sandbox.exec(
			'/opt/contextlayer/node_modules/.bin/wrangler deploy --config ./wrangler.json --no-bundle --dispatch-namespace "$CTX_DISPATCH_NAMESPACE"',
			{
				cwd: "/tmp/slate-deploy",
				env: {
					CI: "true",
					CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
					CLOUDFLARE_API_TOKEN: env.CF_TOKEN,
					CTX_DISPATCH_NAMESPACE: env.CTX_DISPATCH_NAMESPACE,
					WRANGLER_SEND_METRICS: "false",
				},
				timeout: 600_000,
			},
		)
		const result = {
			...deployment,
			stderr: redactSecrets(deployment.stderr, secrets),
			stdout: redactSecrets(deployment.stdout, secrets),
		}
		console.log(result.stdout)
		if (!result.success) {
			throw new Error(`Slate deployment failed: ${result.stderr}`)
		}
		return result
	} finally {
		await sandbox.destroy()
	}
}
