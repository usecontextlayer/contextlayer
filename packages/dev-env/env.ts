import { z } from "zod"

const url = z.url().transform((value) => new URL(value))

const serviceSchema = z.object({
	BETTER_AUTH_URL: url,
	CTX_DISPATCHER_URL: url,
	CTX_PLATFORM_URL: url,
	CTX_VIEWER_AUTH_URL: url,
})

export const developmentServiceKeys = serviceSchema.keyof().options

const schema = serviceSchema.extend({
	CTX_PLATFORM_DATABASE_URL: z
		.url()
		.default("postgresql://postgres:postgres@127.0.0.1:6489/contextlayer_platform"),
	DATABASE_URL: z
		.url()
		.default("postgresql://postgres:postgres@127.0.0.1:5489/contextlayer_web"),
})

export type DevelopmentEnv = z.infer<typeof schema>

export function readDevelopmentEnv() {
	return schema.parse({
		BETTER_AUTH_URL: "http://localhost:0",
		CTX_DISPATCHER_URL: "http://localhost:0",
		CTX_PLATFORM_URL: "http://localhost:0",
		CTX_VIEWER_AUTH_URL: "http://localhost:0",
		...process.env,
	})
}

export function parseDevelopmentServiceUrls(input: unknown) {
	return serviceSchema.parse(input)
}

export const DEVELOPMENT_ORGANIZATION_SLUG = "local-development"

const developmentIdentitySchema = z.object({
	CTX_DEV_USER_EMAIL: z.email(),
	CTX_DEV_USER_PASSWORD: z.string().min(1),
})

export function readDevelopmentIdentityEnv(
	env: Record<string, string | undefined> = process.env,
) {
	return developmentIdentitySchema.parse(env)
}

export function readSlateOAuthEnv(env: Record<string, string>) {
	return z
		.object({ CTX_APP_OAUTH_PROVISIONING_SECRET: z.string().trim().min(1) })
		.parse(env)
}

const polarSchema = z.object({
	POLAR_ACCESS_TOKEN: z.string().min(1),
	POLAR_ENVIRONMENT: z.literal("sandbox"),
	POLAR_FREE_PRODUCT_ID: z.uuid(),
})

export function readPolarEnv(defaults: Record<string, string>) {
	return polarSchema.parse({ ...defaults, ...process.env })
}
