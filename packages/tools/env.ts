import { z } from "zod"

const schema = z.object({
	CTX_ACCESS_TOKEN: z.string().min(1),
	CTX_APP_ID: z.uuid(),
	CTX_PLATFORM_URL: z.url(),
})
export type Bindings = z.input<typeof schema>
export const parseEnv = (bindings: Bindings) => schema.parse(bindings)
