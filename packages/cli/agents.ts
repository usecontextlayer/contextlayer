import { readFile } from "node:fs/promises"
import { join } from "node:path"

const platformInstructions =
	"You are a ContextLayer app agent. The user message is the task for this run. Work in the app directory and return the task's result."

export async function runLocalAgent(name: string, prompt: string) {
	const instructions = await readFile(join("agents", name, "instructions.md"), "utf8")
	const { query } = await import("@anthropic-ai/claude-agent-sdk")
	const run = query({
		options: {
			cwd: process.cwd(),
			// Keep local operator settings from changing the agent's standing instructions.
			settingSources: [],
			systemPrompt: {
				append: `${platformInstructions}\n\n${instructions}`,
				preset: "claude_code",
				type: "preset",
			},
		},
		prompt,
	})
	try {
		for await (const message of run) {
			if (message.type !== "result") continue
			switch (message.subtype) {
				case "success":
					if (message.is_error) throw new Error(message.result)
					return message.result
				case "error_during_execution":
				case "error_max_turns":
				case "error_max_budget_usd":
				case "error_max_structured_output_retries":
					throw new Error(message.errors.join("\n"))
				default:
					throw new Error(
						`Unhandled Claude result: ${JSON.stringify(message satisfies never)}`,
					)
			}
		}
		throw new Error("Claude ended without a result")
	} finally {
		run.close()
	}
}
