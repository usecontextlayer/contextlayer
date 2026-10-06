import { z } from "zod"

export const toolResultSchema = z.object({
	data: z.record(z.string(), z.unknown()),
	error: z.string().nullable(),
	logId: z.string(),
})
