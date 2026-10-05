import { z } from "zod"

export interface Bindings {
	POLAR_ACCESS_TOKEN: string
	POLAR_ENVIRONMENT: "sandbox" | "production"
	CTX_PLATFORM_URL: string
	CTX_VIEWER_AUTH_URL?: string
	APPS: DispatchNamespace
}

export function parseEnv(bindings: Bindings) {
	return z
		.object({
			CTX_PLATFORM_URL: z.url(),
			CTX_VIEWER_AUTH_URL: z.url().default("https://auth.contextlayer.xyz"),
			POLAR_ACCESS_TOKEN: z.string().min(1),
			POLAR_ENVIRONMENT: z.enum(["sandbox", "production"]),
		})
		.parse(bindings)
}
