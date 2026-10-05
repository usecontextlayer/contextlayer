import { z } from "zod"

export const browserEnv = z
	.object({
		CTX_APP_ID: z.uuid().optional(),
		CTX_APP_MANIFEST: z.string().optional(),
		CTX_PLATFORM_URL: z.url().default("https://slate.usecontextlayer.com"),
	})
	.parse({
		CTX_APP_ID: import.meta.env.CTX_APP_ID,
		CTX_APP_MANIFEST: import.meta.env.CTX_APP_MANIFEST,
		CTX_PLATFORM_URL: import.meta.env.CTX_PLATFORM_URL,
	})
