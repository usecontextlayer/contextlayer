import { type Tools, toolsContext } from "@usecontextlayer/tools"
import { createRequestHandler, RouterContextProvider } from "react-router"

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
)

export default {
	async fetch(
		request: Request,
		env: Env & { TOOLS: Tools },
		ctx: ExecutionContext<{ tools: Tools }>,
	) {
		const context = new RouterContextProvider()
		context.set(toolsContext, import.meta.env.DEV ? env.TOOLS : ctx.props.tools)
		return requestHandler(request, context)
	},
}
