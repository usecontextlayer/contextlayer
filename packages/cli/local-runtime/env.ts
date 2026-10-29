import type { SlateAgentJob } from "@usecontextlayer/shared/agent-job"
import type { SlateAgent } from "@usecontextlayer/shared/agent-runtime"
import type { SlateDatabase } from "@usecontextlayer/shared/database-worker"
import type { Meridian } from "@usecontextlayer/shared/meridian"
import { localSnapshotSchema } from "@/local-runtime/schema"

export interface LocalBindings {
	CTX_LOCAL_SNAPSHOT: string
	AGENTS: DurableObjectNamespace<SlateAgent>
	AGENT_JOBS: DurableObjectNamespace<SlateAgentJob>
	DATABASE_STORAGE: DurableObjectNamespace<SlateDatabase>
	MERIDIAN: DurableObjectNamespace<Meridian>
}

export function readSnapshot(env: Pick<LocalBindings, "CTX_LOCAL_SNAPSHOT">) {
	return localSnapshotSchema.parse(JSON.parse(env.CTX_LOCAL_SNAPSHOT))
}
