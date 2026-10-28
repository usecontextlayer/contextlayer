import {
	INSPECTION_SLATE_HEADER,
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
		.transform(({ source }) => ({ namespace: source.namespace, slate: source.repoName })),
	z
		.object({
			provider: z.literal("cloudflare-artifacts"),
			providerData: z.object({ namespace: z.string() }),
			repo: z.string(),
		})
		.transform(({ providerData, repo }) => ({
			namespace: providerData.namespace,
			slate: repo,
		})),
])

function isPreparation(name: unknown) {
	return typeof name === "string" && /^prepare slate(?:-\d+)?$/.test(name)
}

// Retained preparation records can predate native output sensitivity and contain member IDs and physical database mappings.
export function redactPreparationOutput(value: unknown, privateOutput = false): unknown {
	if (Array.isArray(value))
		return value.map((item) => redactPreparationOutput(item, privateOutput))
	if (value === null || typeof value !== "object") return value
	const record = value as Record<string, unknown>
	return Object.fromEntries(
		Object.entries(record).map(([key, item]) => [
			key,
			key === "output" && (privateOutput || isPreparation(record.name))
				? "[REDACTED]"
				: redactPreparationOutput(item, privateOutput),
		]),
	)
}

function configuration(env: InspectionBindings, slate: string): InspectionConfiguration {
	return {
		account_id: env.CLOUDFLARE_ACCOUNT_ID,
		dispatch_namespace: env.CTX_DISPATCH_NAMESPACE,
		script_name: slate,
		workflow_name: env.CTX_CI_WORKFLOW,
	}
}

export async function inspectCloudflare(
	env: InspectionBindings,
	request: Request,
): Promise<Response> {
	const slate = z.uuid().parse(request.headers.get(INSPECTION_SLATE_HEADER))
	if (request.method !== "GET") return new Response(null, { status: 405 })
	const url = new URL(request.url)
	const config = configuration(env, slate)
	if (url.pathname === "/") return Response.json(config)
	const account = `/accounts/${encodeURIComponent(config.account_id)}`
	const instances = `${account}/workflows/${encodeURIComponent(config.workflow_name)}/instances`
	const script = `${account}/workers/dispatch/namespaces/${encodeURIComponent(config.dispatch_namespace)}/scripts/${slate}`
	const instancePath = url.pathname.startsWith(`${instances}/`)
		? url.pathname.slice(instances.length + 1).split("/")
		: null
	const instanceRead =
		instancePath &&
		(instancePath.length === 1 ||
			(instancePath.length === 2 && instancePath[1] === "step"))
	if (url.pathname !== instances && url.pathname !== script && !instanceRead)
		return new Response(null, { status: 404 })

	const secrets = [env.CF_TOKEN, env.R2_SECRET_ACCESS_KEY]
	const read = async (path: string) => {
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
			input.data.slate === slate
		)
	}
	if (instanceRead) {
		const instance = await read(
			`${instances}/${instancePath[0]}${instancePath.length === 1 ? url.search : ""}`,
		)
		if (!instance.ok) return instance
		const data = envelopeSchema.parse(await instance.json())
		if (!belongsToSlate(data.result)) return new Response(null, { status: 404 })
		if (instancePath.length === 1) return Response.json(redactPreparationOutput(data))
		const step = await read(`${url.pathname}${url.search}`)
		if (!step.ok || !isPreparation(url.searchParams.get("name"))) return step
		return Response.json(redactPreparationOutput(await step.json(), true))
	}
	const response = await read(`${url.pathname}${url.search}`)
	if (!response.ok || url.pathname === script) return response
	const data = envelopeSchema.parse(await response.json())
	const records = instanceListSchema.parse(data.result)
	const selected = []
	for (const record of records) {
		const detail = await read(`${instances}/${encodeURIComponent(record.id)}`)
		if (!detail.ok)
			throw new Error(`CI instance inspection failed: HTTP ${detail.status}`)
		if (belongsToSlate(envelopeSchema.parse(await detail.json()).result))
			selected.push(record)
	}
	const info = z.record(z.string(), z.unknown()).optional().parse(data.result_info)
	return Response.json({
		...data,
		result: selected,
		...(info
			? {
					result_info: {
						count: selected.length,
						cursor: info.cursor,
						per_page: info.per_page,
					},
				}
			: {}),
	})
}
