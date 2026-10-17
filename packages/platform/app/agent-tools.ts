import assert from "node:assert/strict"
import {
	Composio,
	dereferenceJsonSchema,
	type Tool,
	ToolRouterSessionExecuteResponseSchema,
} from "@composio/core"
import { defineTool, type Extension } from "@earendil-works/pi-durable"
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode"
import { z } from "zod"
import { zodToJsonSchema } from "zod-to-json-schema"

const sessionResultSchema = zodToJsonSchema(ToolRouterSessionExecuteResponseSchema)

export async function createAgentTools(
	apiKey: string,
	connections: {
		name: string
		session: Awaited<ReturnType<Composio["use"]>>
		toolkit: string
	}[],
): Promise<{ extension: Extension; namespaces: CodemodeNamespace[] }> {
	const composio = new Composio({ apiKey })
	const namespaces: CodemodeNamespace[] = connections.map(({ name, toolkit }) => ({
		description: toolkit,
		name,
		prefix: `${name}__`,
	}))
	const tools = (
		await Promise.all(
			connections.map(async ({ name, session }) => {
				const actions = await composio.tools.getRawToolRouterSessionTools(
					session.sessionId,
				)
				return actions.map((action) => {
					assert(action.inputParameters)
					return defineTool({
						callers: ["tools"],
						deferred: true,
						description: action.description ?? action.name,
						execute: async (args) => {
							const result = await session.execute(
								action.slug,
								args as Record<string, unknown>,
							)
							return {
								isError: result.error !== null,
								output:
									result.error === null ? [] : [{ text: result.error, type: "text" }],
								structuredOutput: z.json().parse(result),
							}
						},
						name: `${name}__${action.slug}`,
						parameters: action.inputParameters,
						structuredOutputSchema: actionResultSchema(action),
					})
				})
			}),
		)
	).flat()
	return {
		extension: {
			name: "connections",
			sections: [
				{
					key: "connections",
					render: () =>
						namespaces.length === 0
							? undefined
							: `Connections:\n${namespaces.map(({ name, description }) => `- ${name}: ${description}`).join("\n")}`,
				},
			],
			tools,
		},
		namespaces,
	}
}

function actionResultSchema(action: Tool) {
	// The catalog wraps data with successful; sessions use error and logId instead.
	const dataSchema = dereferenceJsonSchema(action.outputParameters, {
		onUnresolved: "sentinel",
	})?.properties?.data
	if (!dataSchema) return sessionResultSchema

	return {
		allOf: [
			sessionResultSchema,
			{
				anyOf: [
					{
						properties: { data: dataSchema, error: { type: "null" } },
						type: "object",
					},
					{
						properties: { error: { type: "string" } },
						type: "object",
					},
				],
			},
		],
	}
}
