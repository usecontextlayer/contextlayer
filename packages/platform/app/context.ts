import { createContext } from "react-router"
import type { AuthIdentity } from "@/auth.server"
import type { PlatformDb } from "@/database"
import type { PlatformBindings, PlatformConfig } from "@/env"

export const databaseContext = createContext<PlatformDb>()
export const artifactsContext = createContext<Artifacts>()
export const identityContext = createContext<AuthIdentity>()
export const configContext = createContext<PlatformConfig>()

export type PlatformEnv = {
	Bindings: PlatformBindings & { ASSETS: Fetcher; ARTIFACTS: Artifacts }
	Variables: {
		db: PlatformDb
		config: PlatformConfig
	}
}
