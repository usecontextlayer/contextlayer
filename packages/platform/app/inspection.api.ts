import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import {
	INSPECTION_SLATE_ID_HEADER,
	inspectionConfigurationSchema,
} from "@usecontextlayer/shared/inspection"
import type { OwnerAuthenticatedEnv } from "@/auth.middleware"
import { requireAuth } from "@/auth.middleware"
import { slateTargetSchema } from "@/slates.schema"
import { getSlate } from "@/slates.server"

const inspectionPath = "/{target}/cloudflare"
const accountPath = `${inspectionPath}/accounts/{account}`
const instancesPath = `${accountPath}/workflows/{workflow}/instances`
const targetParams = z.object({ target: slateTargetSchema })
const accountParams = targetParams.extend({ account: z.string() })
const workflowParams = accountParams.extend({ workflow: z.string() })
const routes = [
	[
		inspectionPath,
		"getSlateInspectionConfiguration",
		"Get native inspection configuration",
		inspectionConfigurationSchema,
		targetParams,
	],
	[
		instancesPath,
		"listSlateCiInstances",
		"List the slate's native CI instances",
		z.unknown(),
		workflowParams,
	],
	[
		`${accountPath}/workers/dispatch/namespaces/{namespace}/scripts/{script}`,
		"getSlateWorker",
		"Inspect the published Worker",
		z.unknown(),
		accountParams.extend({ namespace: z.string(), script: z.string() }),
	],
] as const

export function createInspectionApi() {
	const api = new OpenAPIHono<OwnerAuthenticatedEnv>()
	api.use("*", requireAuth)
	for (const [path, operationId, summary, schema, params] of routes) {
		const route = createRoute({
			method: "get",
			operationId,
			path,
			request: { params },
			responses: {
				200: {
					content: {
						"application/json": { schema },
					},
					description: "Native inspection result",
				},
				400: { description: "Invalid inspection parameters" },
				401: { description: "A ContextLayer login is required" },
				403: { description: "Slate management is forbidden" },
				404: { description: "Slate or inspection resource not found" },
			},
			security: [{ bearerAuth: [] }, { webCookie: [] }, { localWebCookie: [] }],
			summary,
			tags: ["Slate inspection"],
		})
		api.openapi<
			typeof route,
			{
				in: { param: z.input<typeof params> }
				out: { param: z.output<typeof params> }
			}
		>(route, async (c) => {
			const access = await getSlate(
				c.var.db,
				c.req.valid("param").target,
				c.var.identity,
				c.var.config.CTX_AUTH_ISSUER,
			)
			if (!access.allowed) return c.body(null, access.reason === "not-found" ? 404 : 403)
			const url = new URL(c.req.url)
			const suffix = url.pathname.split("/cloudflare/")[1]
			return c.env.INSPECTION.fetch(
				new Request(`https://inspection${suffix ? `/${suffix}` : "/"}${url.search}`, {
					headers: { [INSPECTION_SLATE_ID_HEADER]: access.slate.id },
				}),
			)
		})
	}
	return api
}
