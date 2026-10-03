import { z } from "zod"

const schema = z.object({ COMPOSIO_CONSUMER_KEY: z.string().min(1) })
export type Bindings = z.input<typeof schema>
export const parseEnv = (bindings: Bindings) => schema.parse(bindings)
