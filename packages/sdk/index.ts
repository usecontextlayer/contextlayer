import type { Databases } from "@usecontextlayer/shared/databases"
import type { Tools } from "@usecontextlayer/shared/tools"
import { createContext } from "react-router"

export {
	connectionRequiredSchema,
	secretRequiredSchema,
	type Tools,
} from "@usecontextlayer/shared/tools"

export const toolsContext = createContext<Tools>()

export const databasesContext = createContext<Databases>()
export type { Databases } from "@usecontextlayer/shared/databases"
export { database } from "@/database"
