import {
	INSPECTION_SLATE_ID_HEADER,
	type InspectionConfiguration,
} from "@usecontextlayer/shared/inspection"
import { z } from "zod"
import type { BuildBindings } from "@/env"
import { redactSecrets } from "@/redaction"

type InspectionBindings = Pick<
	BuildBindings,
	| "CLOUDFLARE_ACCOUNT_ID"
	| "CTX_CI_WORKFLOW"
	| "CTX_DISPATCH_NAMESPACE"
	| "CF_TOKEN"
	| "R2_SECRET_ACCESS_KEY"
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

function isPreparation(name: unknown) {
	return typeof name === "string" && /^prepare slate(?:-\d+)?$/.test(name)
}

// Retained preparation records can predate native output sensitivity and contain member IDs and physical database mappings.
export function redactPreparationOutput(
	value: unknown,
	redactAllOutputs = false,
): unknown {
	if (Array.isArray(value))
		return value.map((item) => redactPreparationOutput(item, redactAllOutputs))
	if (value === null || typeof value !== "object") return value
	const record = value as Record<string, unknown>
	return Object.fromEntries(
		Object.entries(record).map(([key, item]) => [
			key,
			key === "output" && (redactAllOutputs || isPreparation(record.name))
				? "[REDACTED]"
				: redactPreparationOutput(item, redactAllOutputs),
		]),
	)
}

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
	const instanceSegments = url.pathname.startsWith(`${instancesPath}/`)
		? url.pathname.slice(instancesPath.length + 1).split("/")
		: null
	const isInstanceRead =
		instanceSegments &&
		(instanceSegments.length === 1 ||
			(instanceSegments.length === 2 && instanceSegments[1] === "step"))
	if (url.pathname !== instancesPath && url.pathname !== scriptPath && !isInstanceRead)
		return new Response(null, { status: 404 })

	const secrets = [env.CF_TOKEN, env.R2_SECRET_ACCESS_KEY]
	const readRedactedResponse = async (path: string) => {
		const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
			headers: { Authorization: `Bearer ${env.CF_TOKEN}` },
			redirect: "manual",
		})
		return new Response(redactSecrets(await response.text(), secrets), {
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
	if (isInstanceRead) {
		const instance = await readRedactedResponse(
			`${instancesPath}/${instanceSegments[0]}${instanceSegments.length === 1 ? url.search : ""}`,
		)
		if (!instance.ok) return instance
		const data = envelopeSchema.parse(await instance.json())
		if (!belongsToSlate(data.result)) return new Response(null, { status: 404 })
		if (instanceSegments.length === 1) return Response.json(redactPreparationOutput(data))
		const step = await readRedactedResponse(`${url.pathname}${url.search}`)
		if (!step.ok || !isPreparation(url.searchParams.get("name"))) return step
		return Response.json(redactPreparationOutput(await step.json(), true))
	}
	const response = await readRedactedResponse(`${url.pathname}${url.search}`)
	if (!response.ok || url.pathname === scriptPath) return response
	const data = envelopeSchema.parse(await response.json())
	const records = instanceListSchema.parse(data.result)
	const selected = []
	for (const record of records) {
		const detail = await readRedactedResponse(
			`${instancesPath}/${encodeURIComponent(record.id)}`,
		)
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
