import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { databaseQuerySchema } from "@usecontextlayer/shared/databases"
import { resourcesForConsumer } from "@usecontextlayer/shared/declaration"

const platformInstructions =
	"You are an agent of a ContextLayer slate. The user message is the task for this run. Work in the checkout and return the task's result. Use database_query to read and save persistent data in declared databases. Files are scratch data; schema changes belong in explicitly authored Kysely migrations."

export async function runLocalAgent(name: string, prompt: string) {
	const instructions = await readFile(join("agents", name, "instructions.md"), "utf8")
	const { createServer } = await import("vite")
	const { getPreparedLocalBindings, openLocalDatabases } = await import("@/vite")
	const server = await createServer({
		logLevel: "error",
		server: { host: "127.0.0.1", port: 0 },
	})
	await server.listen()
	const bindings = getPreparedLocalBindings(server)
	const configuration = resourcesForConsumer(bindings.configuration, {
		name,
		type: "agent",
	})
	const storage = await openLocalDatabases(bindings.workerName, configuration.databases)
	const { query, createSdkMcpServer, tool } = await import(
		"@anthropic-ai/claude-agent-sdk"
	)
	const run = query({
		options: {
			allowedTools: ["mcp__databases__database_query"],
			cwd: process.cwd(),
			mcpServers: {
				databases: createSdkMcpServer({
					name: "databases",
					tools: [
						tool(
							"database_query",
							"Query or update a declared persistent SQLite database using parameterized SQL.",
							databaseQuerySchema.shape,
							async ({ slug, sql, params }) => {
								const result = await storage.databases.query(slug, sql, params)
								return { content: [{ text: JSON.stringify(result), type: "text" }] }
							},
						),
					],
				}),
			},
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
		await storage.dispose()
		await server.close()
	}
}
