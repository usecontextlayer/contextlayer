import { z } from "zod"

export const connectionRequiredSchema = z.object({
	reason: z.literal("connection-required"),
	slug: z.string().min(1),
})

export const toolResultSchema = z.object({
	data: z.record(z.string(), z.unknown()),
	error: z.string().nullable(),
	logId: z.string(),
})

export interface Tools {
	call(
		slug: string,
		toolSlug: string,
		args: Record<string, unknown>,
	): Promise<{ data: unknown; logId: string }>
}

export interface ToolsBinding {
	call(
		...args: Parameters<Tools["call"]>
	): Promise<Awaited<ReturnType<Tools["call"]>> | Response>
}
