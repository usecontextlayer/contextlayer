import { z } from "zod"

export const browserEnv = z
	.object({
		CTX_PLATFORM_URL: z.url().default("https://slate.usecontextlayer.com"),
	})
	.parse({
		CTX_PLATFORM_URL: import.meta.env.CTX_PLATFORM_URL,
	})
