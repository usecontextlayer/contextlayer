import type { models, PolarCore } from "@polar-sh/sdk/2026-10"
import { ingestEvents } from "@polar-sh/sdk/2026-10/services/events"
import { z } from "zod"

export const ownerSchema = z.discriminatedUnion("type", [
	z.object({ id: z.string().min(1), type: z.literal("personal") }),
	z.object({ id: z.string().min(1), type: z.literal("organization") }),
])
export type Owner = z.infer<typeof ownerSchema>

export const resolvedSlateSchema = z.object({ id: z.uuid(), owner: ownerSchema })
export type ResolvedSlate = z.infer<typeof resolvedSlateSchema>

const clips = { action_call: 3, loader_call: 1, tool_call: 1 } as const
export type SlateUsageName = keyof typeof clips

const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"])
const dynamicContentTypes = new Set([
	"text/html",
	"application/json",
	"text/x-script",
	"text/plain",
	"text/csv",
	"text/xml",
	"application/xml",
	"application/x-ndjson",
	"application/ndjson",
	"text/event-stream",
])

export function slateRequestUsage(
	request: Request,
	response: Response,
): SlateUsageName | null {
	if (new URL(request.url).pathname === "/slate.json") return null
	const name =
		request.method === "GET"
			? "loader_call"
			: mutationMethods.has(request.method)
				? "action_call"
				: null
	if (!name) return null
	const contentType =
		response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? ""
	const isDynamic =
		dynamicContentTypes.has(contentType) ||
		(contentType.startsWith("application/") && contentType.endsWith("+json")) ||
		(response.status >= 300 && response.status < 400 && response.headers.has("location"))
	return isDynamic ? name : null
}

export async function recordSlateUsage(
	polar: PolarCore,
	slate: ResolvedSlate,
	name: SlateUsageName,
): Promise<models.EventsIngestResponse> {
	return ingestEvents(polar)({
		events: [
			{
				external_customer_id: slate.owner.id,
				metadata: { clips: clips[name], user_code_worker_id: slate.id },
				name,
			},
		],
	})
}
