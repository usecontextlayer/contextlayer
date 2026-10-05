import { createContext } from "react-router"
import type { Connections } from "@/connections"
import type { Viewer } from "@/viewer"

export type { AppConnection, Connections } from "@/connections"
export type { User, Viewer } from "@/viewer"

export interface Tools {
	call(
		slug: string,
		toolSlug: string,
		args: Record<string, unknown>,
	): Promise<{ data: unknown; logId: string }>
}

export const toolsContext = createContext<Tools>()
export const connectionsContext = createContext<Connections>()
export const viewerContext = createContext<Viewer>({ getCurrentUser: async () => null })
