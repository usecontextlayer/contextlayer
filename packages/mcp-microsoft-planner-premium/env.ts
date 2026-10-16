import { z } from "zod"

const schema = z.object({
	CTX_ENTRA_CLIENT_ID: z.guid(),
	CTX_ENTRA_CLIENT_SECRET: z.string().min(1),
})

export type Bindings = z.input<typeof schema>

export function parseEnv(bindings: Bindings) {
	return schema.parse(bindings)
}

export function parseRecorderEnv() {
	return z
		.object({
			DV_TOKEN_FILE: z
				.string()
				.min(1, "DV_TOKEN_FILE is required (path to a file holding the token)"),
		})
		.parse(process.env)
}
