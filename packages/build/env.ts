import type { CiBindings } from "@cloudflare/ci/worker"
import type { SlateDatabase } from "@usecontextlayer/shared/database-worker"
import type { SlateProvisioning } from "@usecontextlayer/shared/slate-provisioning"

export type BuildBindings = CiBindings & {
	CTX_DISPATCH_NAMESPACE: string
	DATABASES: DurableObjectNamespace<SlateDatabase>
	PROVISIONING: {
		prepare(slateId: string, commit: string): Promise<SlateProvisioning>
		provisionSchedules(prepared: SlateProvisioning): Promise<void>
	}
}
