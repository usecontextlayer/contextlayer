import { z } from "zod"

const databaseSchema = z.object({
	CTX_PLATFORM_DATABASE_URL: z.url(),
})

const sharedSecretsSchema = z.object({
	CTX_CUSTOMER_CREDENTIALS_DOPPLER_CONFIG: z.string().min(1),
	CTX_CUSTOMER_CREDENTIALS_DOPPLER_PROJECT: z.string().min(1),
	CTX_CUSTOMER_CREDENTIALS_DOPPLER_TOKEN: z.string().min(1),
})

export function parseSharedSecretsEnv(raw: Record<string, unknown>) {
	return sharedSecretsSchema.parse(raw)
}

export function parseDatabaseEnv(raw: Record<string, unknown>) {
	return databaseSchema.parse(raw)
}

const schema = databaseSchema.extend({
	COMPOSIO_API_KEY: z.string().min(1),
	...sharedSecretsSchema.partial().shape,
	CTX_APPS_DOMAIN: z.hostname().default("contextlayer.xyz"),
	CTX_AUTH_ISSUER: z.url().default("https://www.usecontextlayer.com/api/auth"),
	POLAR_ACCESS_TOKEN: z.string().min(1),
	POLAR_ENVIRONMENT: z.enum(["sandbox", "production"]),
	POLAR_WEBHOOK_SECRET: z.string().min(1),
})

export function parsePlatformEnv(raw: Record<string, unknown>) {
	return schema.parse(raw)
}

export type PlatformBindings = z.input<typeof schema>
export type PlatformConfig = z.output<typeof schema>
