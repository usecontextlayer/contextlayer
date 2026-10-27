import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"
import { name, version } from "@/package.json"

export function readLocalSecret(name: string) {
	return process.env[name] ?? null
}

export const databaseEnv = z
	.object({ CTX_DATABASE_URL: z.url().optional() })
	.parse(process.env)

export const envSchema = z.object({
	CTX_AUTH_CLIENT_ID: z.string().min(1).default("QBFOYTTCdjpEiXwgDNnovDPoJBYAfRpF"),
	CTX_AUTH_ISSUER: z.url().default("https://www.usecontextlayer.com/api/auth"),
	CTX_CONFIG_DIR: z
		.string()
		.min(1)
		.default(join(homedir(), ".contextlayer"))
		.transform((directory) => resolve(directory)),
	CTX_PLATFORM_URL: z.url().default("https://platform.usecontextlayer.com"),
})

export const env = envSchema.parse(process.env)

const commandEnv = z
	.object({
		CTX_CLI_COMMAND: z.string().min(1).optional(),
	})
	.parse(process.env)

export function readCliCommand(settings: typeof env) {
	return (
		commandEnv.CTX_CLI_COMMAND ??
		`npx --yes --prefix '${settings.CTX_CONFIG_DIR.replaceAll("'", "'\\''")}' ${name}@${version}`
	)
}
