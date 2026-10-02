import { z } from "zod"

export interface Bindings {
	CTX_PLATFORM_URL: string
	APPS: DispatchNamespace
}

export function parseEnv(bindings: Bindings) {
	return z.object({ CTX_PLATFORM_URL: z.url() }).parse(bindings)
}
