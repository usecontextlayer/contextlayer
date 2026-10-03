import { createContext } from "react-router"

export interface Tools {
	call(
		accountAlias: string,
		toolSlug: string,
		args: Record<string, unknown>,
	): Promise<{ data: unknown; logId: string }>
}

export const toolsContext = createContext<Tools>()
