import type { RouteConfig } from "@hono/zod-openapi"

export const managementSecurity: NonNullable<RouteConfig["security"]> = [
	{ bearerAuth: [] },
	{ webCookie: [] },
	{ localWebCookie: [] },
]
