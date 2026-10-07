import { ResourceSchema, ToolSchema } from "@modelcontextprotocol/core"
import { z } from "zod"
import { type Slate, slateSchema } from "@/lib/slate"

export const MCP_MANIFEST_PATH = "/mcp.json"

export interface McpManifest {
	resources: (z.infer<typeof ResourceSchema> & { path: string })[]
	tools: (z.infer<typeof ToolSchema> & { slate: Slate })[]
}

export const mcpManifestSchema: z.ZodType<McpManifest> = z.object({
	resources: z.array(ResourceSchema.extend({ path: z.string() })),
	tools: z.array(ToolSchema.extend({ slate: slateSchema })),
})
