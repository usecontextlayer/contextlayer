import { createRequestHandler, RouterContextProvider } from "react-router"
import { type Databases, databasesContext, type Tools, toolsContext } from "@/index"

interface LocalBindings {
	DATABASES: Databases
	TOOLS: Tools
}

interface AppProps {
	databases: Databases
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
			context.set(databasesContext, development ? env.DATABASES : ctx.props.databases)
			context.set(toolsContext, development ? env.TOOLS : ctx.props.tools)
			return requestHandler(request, context)
		},
	}
}
