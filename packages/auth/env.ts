import { z } from "zod"

const schema = z.object({
	CTX_APPS_DOMAIN: z.hostname().default("contextlayer.xyz"),
	CTX_AUTH_ISSUER: z.url().default("https://www.usecontextlayer.com/api/auth"),
})

export type Bindings = z.input<typeof schema>

export function parseEnv(bindings: Bindings) {
	return schema.parse(bindings)
}
