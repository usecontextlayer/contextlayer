import { createRequestHandler, RouterContextProvider } from "react-router"
import { type Tools, toolsContext, type Viewer, viewerContext } from "@/index"

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
			env: { TOOLS: Tools; VIEWER: Viewer },
			ctx: ExecutionContext<{ tools: Tools; viewer?: Viewer }>,
		) {
			const context = new RouterContextProvider()
			context.set(toolsContext, development ? env.TOOLS : ctx.props.tools)
			const viewer = development ? env.VIEWER : ctx.props.viewer
			if (viewer) context.set(viewerContext, viewer)
			return requestHandler(request, context)
		},
	}
}
