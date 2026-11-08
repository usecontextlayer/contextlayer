import assert from "node:assert/strict"
import {
	Composio,
	dereferenceJsonSchema,
	type Tool,
	ToolRouterSessionExecuteResponseSchema,
} from "@composio/core"
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable"
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
	resolveSession: (
		name: string,
		toolkit: string,
	) => Promise<Awaited<ReturnType<Composio["use"]>>>,
) {
	const composio = new Composio({ apiKey })
	const namespaces: CodemodeNamespace[] = connections.map(({ name, toolkit }) => ({
		description: toolkit,
		name,
		prefix: `${name}__`,
	}))
	const tools = (
		await Promise.all(
			connections.map(async ({ name, session, toolkit }) => {
				const actions = await composio.tools.getRawToolRouterSessionTools(
					session.sessionId,
				)
				return actions.map((action) => {
					assert(action.inputParameters)
					return {
						callers: ["tools"],
						deferred: true,
						description: action.description ?? action.name,
						execute: async (args) => {
							const current = await resolveSession(name, toolkit)
							const result = await current.execute(
								action.slug,
								args as Record<string, unknown>,
							)
							return {
								isError: result.resultType !== "completed",
								output: result.error ? [{ text: result.error, type: "text" }] : [],
								structuredOutput: z.json().parse(result),
							}
						},
						name: `${name}__${action.slug}`,
						parameters: action.inputParameters,
						structuredOutputSchema: actionResultSchema(action),
					} satisfies ToolRegistration
				})
			}),
		)
	).flat()
	return {
		extension: {
			name: "connections",
			tools,
		},
		namespaces,
	} satisfies { extension: Extension; namespaces: CodemodeNamespace[] }
}

function actionResultSchema(action: Tool) {
	// The catalog wraps data with successful; sessions report resultType instead.
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
						properties: { data: dataSchema, resultType: { const: "completed" } },
						type: "object",
					},
					{
						properties: { resultType: { enum: ["failed", "blocked"] } },
						type: "object",
					},
				],
			},
		],
	}
}
