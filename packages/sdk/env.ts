import { slateSchema } from "@usecontextlayer/shared/slate"
import { z } from "zod"

const schema = z.object({
	CTX_ACCESS_TOKEN: z.string().min(1),
	CTX_APP_ID: z.uuid(),
	CTX_APP_MANIFEST: z.string().transform((value) => slateSchema.parse(JSON.parse(value))),
	CTX_AUTH_ISSUER: z.url(),
	CTX_PLATFORM_URL: z.url(),
})
export type Bindings = z.input<typeof schema>
export const parseEnv = (bindings: Bindings) => schema.parse(bindings)
