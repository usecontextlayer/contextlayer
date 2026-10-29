import {
	type ToolRouterSessionExecuteResponse,
	ToolRouterSessionExecuteResponseSchema,
	ToolSchema,
} from "@composio/core"
import type { OpenAPIHono } from "@hono/zod-openapi"
import { z } from "zod"
import { zodToJsonSchema } from "zod-to-json-schema"

type OpenApiSchema = NonNullable<
	NonNullable<ReturnType<OpenAPIHono["getOpenAPI31Document"]>["components"]>["schemas"]
>[string]

export const accountSessionToolSchema: OpenApiSchema = (
	zodToJsonSchema(ToolSchema, {
		basePath: ["#", "components"],
		definitionPath: "schemas",
		name: "ComposioTool",
		target: "openApi3",
	}) as { schemas: { ComposioTool: OpenApiSchema } }
).schemas.ComposioTool

export const accountSessionToolsSchema = {
	items: { $ref: "#/components/schemas/ComposioTool" },
	type: "array",
} as const

export const accountToolResultSchema = z
	.fromJSONSchema(
		zodToJsonSchema(ToolRouterSessionExecuteResponseSchema, {
			name: "ToolRouterSessionExecuteResponse",
		}) as z.core.JSONSchema.JSONSchema,
	)
	.transform(
		(result): ToolRouterSessionExecuteResponse =>
			ToolRouterSessionExecuteResponseSchema.parse(result),
	)
