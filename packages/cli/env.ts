import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

export function readLocalSecret(name: string) {
	return process.env[name] ?? null
}

export const databaseEnv = z
	.object({ CTX_DATABASE_URL: z.url().optional() })
	.parse(process.env)

export const env = z
	.object({
		CTX_AUTH_CLIENT_ID: z.string().min(1).default("QBFOYTTCdjpEiXwgDNnovDPoJBYAfRpF"),
		CTX_AUTH_ISSUER: z.url().default("https://www.usecontextlayer.com/api/auth"),
		CTX_CONFIG_DIR: z.string().min(1).default(join(homedir(), ".contextlayer")),
		CTX_PLATFORM_URL: z.url().default("https://platform.usecontextlayer.com"),
	})
	.parse(process.env)
