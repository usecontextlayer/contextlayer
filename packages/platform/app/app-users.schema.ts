import { z } from "@hono/zod-openapi"

export const appUserSchema = z.object({ app_id: z.string(), user_id: z.string() })
