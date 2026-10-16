import { z } from "zod"

const schema = z.object({
	MICROSOFT_CLIENT_ID: z.guid(),
	MICROSOFT_CLIENT_SECRET: z.string().min(1),
})

export type Bindings = z.input<typeof schema>

export function parseEnv(bindings: Bindings) {
	return schema.parse(bindings)
}

export function parseRecorderEnv() {
	return z
		.object({
			CTX_DATAVERSE_TOKEN_FILE: z
				.string()
				.min(
					1,
					"CTX_DATAVERSE_TOKEN_FILE is required (path to a file holding the token)",
				),
		})
		.parse(process.env)
}

export function parseReadRecorderEnv() {
	return {
		...parseRecorderEnv(),
		...z.object({ CTX_DATAVERSE_ORG_URL: z.url() }).parse(process.env),
	}
}
