import { z } from "zod"

export const chromeSignInSchema = z.object({ state: z.uuid(), token: z.string().min(1) })
