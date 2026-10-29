import assert from "node:assert/strict"
import {
	dereferenceJsonSchema,
	type Tool,
	type ToolRouterSessionExecuteResponse,
	ToolRouterSessionExecuteResponseSchema,
} from "@composio/core"
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable"
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode"
import { z } from "zod"
import { zodToJsonSchema } from "zod-to-json-schema"

const sessionResultSchema = zodToJsonSchema(ToolRouterSessionExecuteResponseSchema)

export function createAgentTools(
	connections: {
		name: string
		actions: Tool[]
		execute: (
			tool: string,
			args: Record<string, unknown>,
		) => Promise<ToolRouterSessionExecuteResponse>
		toolkit: string
	}[],
) {
	const namespaces: CodemodeNamespace[] = connections.map(({ name, toolkit }) => ({
		description: toolkit,
		name,
		prefix: `${name}__`,
	}))
	const tools = connections.flatMap(({ name, actions, execute }) =>
		actions.map((action) => {
			assert(action.inputParameters)
			return {
				callers: ["tools"],
				deferred: true,
				description: action.description ?? action.name,
				execute: async (args) => {
					const result = await execute(action.slug, args as Record<string, unknown>)
					return {
						isError: result.error !== null,
						output: result.error === null ? [] : [{ text: result.error, type: "text" }],
						structuredOutput: z.json().parse(result),
					}
				},
				name: `${name}__${action.slug}`,
				parameters: action.inputParameters,
				structuredOutputSchema: actionResultSchema(action),
			} satisfies ToolRegistration
		}),
	)
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
	} satisfies { extension: Extension; namespaces: CodemodeNamespace[] }
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
