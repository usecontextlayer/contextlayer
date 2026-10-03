import { z } from "zod"

export const env = z
	.object({
		CTX_AUTH_CLIENT_ID: z.string().min(1).default("QBFOYTTCdjpEiXwgDNnovDPoJBYAfRpF"),
		CTX_AUTH_ISSUER: z.url().default("https://www.usecontextlayer.com/api/auth"),
		CTX_PLATFORM_URL: z.url().default("https://slate.usecontextlayer.com"),
	})
	.parse(process.env)
