import { createContext } from "react-router"
import type { Viewer } from "@/viewer"

export type { User, Viewer } from "@/viewer"

export interface Tools {
	call(
		slug: string,
		toolSlug: string,
		args: Record<string, unknown>,
	): Promise<{ data: unknown; logId: string }>
}

export const toolsContext = createContext<Tools>()
export const viewerContext = createContext<Viewer>({ getCurrentUser: async () => null })
