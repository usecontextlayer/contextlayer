import { z } from "zod"

const databaseSchema = z.object({
	CTX_PLATFORM_DATABASE_URL: z.url(),
})

export function parseDatabaseEnv(raw: Record<string, unknown>) {
	return databaseSchema.parse(raw)
}

const schema = databaseSchema.extend({
	CTX_APPS_DOMAIN: z.hostname().default("contextlayer.xyz"),
})

export function parsePlatformEnv(raw: Record<string, unknown>) {
	return schema.parse(raw)
}

export type PlatformBindings = z.input<typeof schema>
export type PlatformConfig = z.output<typeof schema>
