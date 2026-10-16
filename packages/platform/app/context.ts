import type { SlateDatabase } from "@usecontextlayer/shared/database-worker"
import { createContext } from "react-router"
import type { SlateAgentJob } from "@/agent-job"
import type { SlateAgent } from "@/agent-runtime"
import type { OwnerIdentity } from "@/auth.server"
import type { PlatformDb } from "@/database"
import type { PlatformBindings, PlatformConfig } from "@/env"

export const databaseContext = createContext<PlatformDb>()
export const slatesContext = createContext<DispatchNamespace>()
export const artifactsContext = createContext<Artifacts>()
export const identityContext = createContext<OwnerIdentity | null>(null)
export const configContext = createContext<PlatformConfig>()
export const databasesContext = createContext<PlatformEnv["Bindings"]["DATABASES"]>()
export const agentsContext = createContext<PlatformEnv["Bindings"]["AGENTS"]>()

export type PlatformEnv = {
	Bindings: PlatformBindings & {
		AGENTS: DurableObjectNamespace<SlateAgent>
		AGENT_JOBS: DurableObjectNamespace<SlateAgentJob>
		SLATES: DispatchNamespace
		ASSETS: Fetcher
		ARTIFACTS: Artifacts
		DATABASES: DurableObjectNamespace<SlateDatabase>
	}
	Variables: {
		db: PlatformDb
		config: PlatformConfig
	}
}
