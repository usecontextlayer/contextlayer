import { createMcpHandler } from "@modelcontextprotocol/server"
import { Hono } from "hono"
import { createMcpServer } from "@/lib/server"

const app = new Hono()
const handler = createMcpHandler(createMcpServer)

app.all("/mcp", (c) => handler.fetch(c.req.raw))

export default app
