import { createRequestHandler, RouterContextProvider } from "react-router"
import {
	type Connections,
	connectionsContext,
	type Tools,
	toolsContext,
	type Viewer,
	viewerContext,
} from "@/index"

interface LocalBindings {
	TOOLS: Tools
	VIEWER: Viewer
	CONNECTIONS: Connections
}

interface AppProps {
	tools: Tools
	viewer?: Viewer
	connections?: Connections
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
			const viewer = development ? env.VIEWER : ctx.props.viewer
			if (viewer) context.set(viewerContext, viewer)
			const connections = development ? env.CONNECTIONS : ctx.props.connections
			if (connections) context.set(connectionsContext, connections)
			return requestHandler(request, context)
		},
	}
}
