import { z } from "zod"

export const tool = {
	_meta: { ui: { resourceUri: "ui://echo/index.html" } },
	inputSchema: z.object({ value: z.number() }),
	name: "echo",
	outputSchema: z.object({
		authorization: z.null(),
		runtime: z.string(),
		value: z.unknown(),
	}),
}

export function handler(args: unknown) {
	const { value } = args as z.infer<typeof tool.inputSchema>
	return {
		content: [{ text: String(value), type: "text" as const }],
		structuredContent: { authorization: null, runtime: navigator.userAgent, value },
	}
}
