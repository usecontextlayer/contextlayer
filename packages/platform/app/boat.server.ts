import { z } from "zod"

// boat.dev runs each agent job: a Linux sandbox with Claude Code installed, driven through boat's
// HTTP API. Every response is validated against the shape this platform relies on.
export function boatClient(apiKey: string) {
	return async <T extends z.ZodType>(
		method: string,
		path: string,
		schema: T,
		body?: unknown,
	): Promise<z.infer<T>> => {
		const response = await fetch(`https://boat.dev/api/v1${path}`, {
			body: body === undefined ? undefined : JSON.stringify(body),
			headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
			method,
		})
		const json = await response.json()
		if (!response.ok) {
			const error = z.object({ code: z.string(), message: z.string() }).parse(json)
			throw new Error(
				`boat ${method} ${path} -> ${response.status} ${error.code}: ${error.message}`,
			)
		}
		return schema.parse(json)
	}
}

export const sandboxResponseSchema = z.object({
	sandbox: z.object({ id: z.string(), state: z.string() }),
})
export const promptResponseSchema = z.object({ conversationId: z.string() })
const promptEventSchema = z.object({ taskId: z.string() })
// Newest first. Starting a job sends its first prompt, so a job's conversation always has one.
export const promptEventsSchema = z.object({
	events: z.tuple([promptEventSchema], promptEventSchema),
})
export const promptRunSchema = z.object({
	promptRun: z.object({
		status: z.enum(["sending", "queued", "running", "finished", "failed", "interrupted"]),
	}),
})
export const fileResponseSchema = z.object({ content: z.string() })
export const commandResponseSchema = z.object({
	exitCode: z.number(),
	stderr: z.string(),
})
