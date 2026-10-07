import type { Databases } from "@usecontextlayer/shared/databases"
import { createContext } from "react-router"

export interface Tools {
	call(
		slug: string,
		toolSlug: string,
		args: Record<string, unknown>,
	): Promise<{ data: unknown; logId: string }>
}

export const toolsContext = createContext<Tools>()

export const databasesContext = createContext<Databases>()
export type { Databases } from "@usecontextlayer/shared/databases"
export { database } from "@/database"
