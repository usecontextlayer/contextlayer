import type { SlateDatabase } from "@usecontextlayer/shared/database-worker"
import type { SlateProvisioning } from "@usecontextlayer/shared/slate-provisioning"
import { createContext } from "react-router"
import type { SlateAgentJob } from "@/agent-job"
import type { SlateAgent } from "@/agent-runtime"
import type { OwnerIdentity } from "@/auth.server"
import type { PlatformDb } from "@/database"
import type { PlatformBindings, PlatformConfig } from "@/env"
import type { Meridian } from "@/meridian"

export const databaseContext = createContext<PlatformDb>()
export const slatesContext = createContext<DispatchNamespace>()
export const artifactsContext = createContext<Artifacts>()
export const identityContext = createContext<OwnerIdentity | null>(null)
export const configContext = createContext<PlatformConfig>()
export const memberProvisioningContext =
	createContext<PlatformEnv["Bindings"]["MEMBER_PROVISIONING"]>()
export const meridianContext = createContext<PlatformEnv["Bindings"]["MERIDIAN"]>()

export type PlatformEnv = {
	Bindings: PlatformBindings & {
		MERIDIAN: DurableObjectNamespace<Meridian>
		AGENTS: DurableObjectNamespace<SlateAgent>
		AGENT_JOBS: DurableObjectNamespace<SlateAgentJob>
		SLATES: DispatchNamespace
		ASSETS: Fetcher
		ARTIFACTS: Artifacts
		DATABASES: DurableObjectNamespace<SlateDatabase>
		MEMBER_PROVISIONING: Workflow<SlateProvisioning>
	}
	Variables: {
		db: PlatformDb
		config: PlatformConfig
	}
}
