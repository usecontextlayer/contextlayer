import { z } from "zod"

export interface Bindings {
	CTX_PLATFORM_URL: string
	CTX_AUTH_ISSUER?: string
	CTX_VIEWER_AUTH_URL?: string
	APPS: DispatchNamespace
}

export function parseEnv(bindings: Bindings) {
	return z
		.object({
			CTX_AUTH_ISSUER: z.url().default("https://www.usecontextlayer.com/api/auth"),
			CTX_PLATFORM_URL: z.url(),
			CTX_VIEWER_AUTH_URL: z.url().default("https://auth.contextlayer.xyz"),
		})
		.parse(bindings)
}
