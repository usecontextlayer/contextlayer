import { z } from "zod"

export const env = z
	.object({
		CTX_PLATFORM_URL: z.url().default("http://localhost:3010"),
	})
	.parse(process.env)
