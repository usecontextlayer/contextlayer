import { z } from "zod"

export const tool = {
	description: "",
	inputSchema: z.object({}),
	name: "tool",
}

export function handler(_args: z.infer<typeof tool.inputSchema>) {}
