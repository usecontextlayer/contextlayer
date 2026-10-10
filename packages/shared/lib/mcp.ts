import { ResourceSchema, ToolSchema } from "@modelcontextprotocol/core"
import { z } from "zod"
import { type Declaration, declarationSchema } from "@/lib/declaration"

export const MCP_MANIFEST_PATH = "/mcp.json"

export interface McpManifest {
	resources: (z.infer<typeof ResourceSchema> & { path: string })[]
	tools: (z.infer<typeof ToolSchema> & { declaration: Declaration })[]
}

export const mcpManifestSchema: z.ZodType<McpManifest> = z.object({
	resources: z.array(ResourceSchema.extend({ path: z.string() })),
	tools: z.array(ToolSchema.extend({ declaration: declarationSchema })),
})
