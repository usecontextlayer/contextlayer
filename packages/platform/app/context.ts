import { createContext } from "react-router"
import type { PlatformDb } from "@/database"
import type { PlatformBindings, PlatformConfig } from "@/env"

export const databaseContext = createContext<PlatformDb>()
export const artifactsContext = createContext<Artifacts>()

export type PlatformEnv = {
	Bindings: PlatformBindings & { ASSETS: Fetcher; ARTIFACTS: Artifacts }
	Variables: {
		db: PlatformDb
		config: PlatformConfig
	}
}
