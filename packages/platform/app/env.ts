import { z } from "zod"

const databaseSchema = z.object({
	CTX_PLATFORM_DATABASE_URL: z.url(),
})

export function parseDatabaseEnv(raw: NodeJS.ProcessEnv) {
	return databaseSchema.parse(raw)
}

const schema = databaseSchema.extend({
	CLOUDFLARE_ACCOUNT_ID: z.string().min(1),
	CLOUDFLARE_API_TOKEN: z.string().min(1),
	CTX_APPS_DOMAIN: z.hostname().default("contextlayer.xyz"),
	CTX_ARTIFACTS_NAMESPACE: z.string().default("contextlayer-dev"),
	CTX_PLATFORM_PORT: z.coerce.number().int().min(1).max(65535).default(3010),
})

export function parsePlatformEnv(raw: NodeJS.ProcessEnv) {
	return schema.parse(raw)
}
