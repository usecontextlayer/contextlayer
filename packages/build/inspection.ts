import {
	INSPECTION_SLATE_ID_HEADER,
	type InspectionConfiguration,
} from "@usecontextlayer/shared/inspection"
import { z } from "zod"
import type { BuildBindings } from "@/env"

type InspectionBindings = Pick<
	BuildBindings,
	"CLOUDFLARE_ACCOUNT_ID" | "CTX_CI_WORKFLOW" | "CTX_DISPATCH_NAMESPACE" | "CF_TOKEN"
>

const envelopeSchema = z.looseObject({ result: z.unknown() })
const instanceSchema = z.looseObject({ params: z.unknown() })
const instanceListSchema = z.array(z.looseObject({ id: z.string() }))
const inputSchema = z.union([
	z
		.object({
			source: z.object({ namespace: z.string(), repoName: z.string() }),
			type: z.literal("cf.artifacts.repo.pushed"),
		})
		.transform(({ source }) => ({
			namespace: source.namespace,
			slateId: source.repoName,
		})),
	z
		.object({
			provider: z.literal("cloudflare-artifacts"),
			providerData: z.object({ namespace: z.string() }),
			repo: z.string(),
		})
		.transform(({ providerData, repo }) => ({
			namespace: providerData.namespace,
			slateId: repo,
		})),
])

function configuration(
	env: InspectionBindings,
	slateId: string,
): InspectionConfiguration {
	return {
		account_id: env.CLOUDFLARE_ACCOUNT_ID,
		dispatch_namespace: env.CTX_DISPATCH_NAMESPACE,
		script_name: slateId,
		workflow_name: env.CTX_CI_WORKFLOW,
	}
}

export async function inspectCloudflare(
	env: InspectionBindings,
	request: Request,
): Promise<Response> {
	const slateId = z.uuid().parse(request.headers.get(INSPECTION_SLATE_ID_HEADER))
	if (request.method !== "GET") return new Response(null, { status: 405 })
	const url = new URL(request.url)
	const config = configuration(env, slateId)
	if (url.pathname === "/") return Response.json(config)
	const accountPath = `/accounts/${encodeURIComponent(config.account_id)}`
	const instancesPath = `${accountPath}/workflows/${encodeURIComponent(config.workflow_name)}/instances`
	const scriptPath = `${accountPath}/workers/dispatch/namespaces/${encodeURIComponent(config.dispatch_namespace)}/scripts/${slateId}`
	if (url.pathname !== instancesPath && url.pathname !== scriptPath)
		return new Response(null, { status: 404 })

	const readResponse = async (path: string) => {
		const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
			headers: { Authorization: `Bearer ${env.CF_TOKEN}` },
			redirect: "manual",
		})
		return new Response(response.body, {
			headers: {
				"Content-Type": response.headers.get("Content-Type") ?? "application/json",
			},
			status: response.status,
		})
	}
	const belongsToSlate = (value: unknown) => {
		const input = inputSchema.safeParse(instanceSchema.parse(value).params)
		return (
			input.success &&
			input.data.namespace === config.dispatch_namespace &&
			input.data.slateId === slateId
		)
	}
	const response = await readResponse(`${url.pathname}${url.search}`)
	if (!response.ok || url.pathname === scriptPath) return response
	const data = envelopeSchema.parse(await response.json())
	const records = instanceListSchema.parse(data.result)
	const selected = []
	for (const record of records) {
		const detail = await readResponse(`${instancesPath}/${encodeURIComponent(record.id)}`)
		if (!detail.ok)
			throw new Error(`CI instance inspection failed: HTTP ${detail.status}`)
		if (belongsToSlate(envelopeSchema.parse(await detail.json()).result))
			selected.push(record)
	}
	const pagination = z.record(z.string(), z.unknown()).optional().parse(data.result_info)
	return Response.json({
		...data,
		result: selected,
		...(pagination
			? {
					result_info: {
						count: selected.length,
						cursor: pagination.cursor,
						per_page: pagination.per_page,
					},
				}
			: {}),
	})
}
