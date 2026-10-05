import { createContext } from "react-router"
import type { AppAgent } from "@/agent-runtime"
import type { AuthIdentity } from "@/auth.server"
import type { PlatformDb } from "@/database"
import type { PlatformBindings, PlatformConfig } from "@/env"

export const databaseContext = createContext<PlatformDb>()
export const appsContext = createContext<DispatchNamespace>()
export const artifactsContext = createContext<Artifacts>()
export const identityContext = createContext<AuthIdentity | null>(null)
export const configContext = createContext<PlatformConfig>()

export type PlatformEnv = {
	Bindings: PlatformBindings & {
		AGENTS: DurableObjectNamespace<AppAgent>
		APPS: DispatchNamespace
		ASSETS: Fetcher
		ARTIFACTS: Artifacts
	}
	Variables: {
		db: PlatformDb
		config: PlatformConfig
	}
}
