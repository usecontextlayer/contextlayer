import { createRequestHandler, RouterContextProvider } from "react-router"
import { type Tools, toolsContext } from "@/index"

export function createApp({
	build,
	mode,
	development,
}: {
	build: Parameters<typeof createRequestHandler>[0]
	mode: string
	development: boolean
}) {
	const requestHandler = createRequestHandler(build, mode)
	return {
		async fetch(
			request: Request,
			env: { TOOLS: Tools },
			ctx: ExecutionContext<{ tools: Tools }>,
		) {
			const context = new RouterContextProvider()
			context.set(toolsContext, development ? env.TOOLS : ctx.props.tools)
			return requestHandler(request, context)
		},
	}
}
