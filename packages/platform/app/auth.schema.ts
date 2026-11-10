import type { RouteConfig } from "@hono/zod-openapi"

export const platformCredentialSecurity: NonNullable<RouteConfig["security"]> = [
	{ bearerAuth: [] },
	{ webCookie: [] },
	{ localWebCookie: [] },
]
