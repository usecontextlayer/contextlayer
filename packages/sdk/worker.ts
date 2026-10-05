import { createRequestHandler, RouterContextProvider } from "react-router"
import { type Tools, toolsContext } from "@/index"

interface LocalBindings {
	TOOLS: Tools
}

interface AppProps {
	tools: Tools
}

export type App = Required<
	Pick<ExportedHandler<LocalBindings, unknown, unknown, AppProps>, "fetch">
>

export function createApp({
	build,
	mode,
	development,
}: {
	build: Parameters<typeof createRequestHandler>[0]
	mode: string
	development: boolean
}): App {
	const requestHandler = createRequestHandler(build, mode)
	return {
		async fetch(request, env, ctx) {
			const context = new RouterContextProvider()
			context.set(toolsContext, development ? env.TOOLS : ctx.props.tools)
			return requestHandler(request, context)
		},
	}
}
