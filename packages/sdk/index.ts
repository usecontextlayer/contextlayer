import type { Tools } from "@usecontextlayer/shared/tools"
import { createContext } from "react-router"

export { connectionRequiredSchema, type Tools } from "@usecontextlayer/shared/tools"

export const toolsContext = createContext<Tools>()
