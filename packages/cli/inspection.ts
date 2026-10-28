import { fileURLToPath } from "node:url"
import { inspectionConfigurationSchema } from "@usecontextlayer/shared/inspection"
import { execa } from "execa"
import { getAccessToken } from "@/auth"
import { env } from "@/env"

export function isNativeHelpRequest(args: readonly string[]) {
	return args.length === 0 || args.includes("--help") || args.includes("-h")
}

export async function inspectSlate(
	kind: "ci" | "worker",
	target: string,
	args: string[],
) {
	const inspectionUrl = new URL(
		`/api/slates/${encodeURIComponent(target)}/cloudflare`,
		env.CTX_PLATFORM_URL,
	)
	const helpRequested = isNativeHelpRequest(args)
	const token = helpRequested ? "contextlayer-help" : await getAccessToken(env)
	const config = helpRequested
		? {
				account_id: "contextlayer",
				dispatch_namespace: "contextlayer",
				script_name: target,
				workflow_name: "contextlayer-build",
			}
		: await fetch(inspectionUrl, { headers: { Authorization: `Bearer ${token}` } }).then(
				async (response) => {
					if (!response.ok)
						throw new Error(`Slate inspection request failed: HTTP ${response.status}`)
					return inspectionConfigurationSchema.parse(await response.json())
				},
			)
	const commandPrefix =
		kind === "ci"
			? ["workflows", "instances"]
			: ["workers-for-platforms", "dispatch-namespaces", "scripts"]
	const resourceArguments = helpRequested
		? []
		: kind === "ci"
			? ["--workflow-name", config.workflow_name]
			: [config.script_name, "--dispatch-namespace", config.dispatch_namespace]
	const result = await execa(
		process.execPath,
		[
			fileURLToPath(new URL("./bin/cf", import.meta.resolve("cf/package.json"))),
			...commandPrefix,
			...args,
			...resourceArguments,
		],
		{
			env: {
				CLOUDFLARE_ACCOUNT_ID: config.account_id,
				CLOUDFLARE_API_BASE_URL: inspectionUrl.href,
				CLOUDFLARE_API_TOKEN: token,
			},
			reject: false,
			stdio: "inherit",
		},
	)
	process.exitCode = result.exitCode
}
