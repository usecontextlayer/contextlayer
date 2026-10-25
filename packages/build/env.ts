import type { CiBindings, DirectoryBackup } from "@cloudflare/ci/worker"
import type { SlateDatabase } from "@usecontextlayer/shared/database-worker"
import type { SlateProvisioning } from "@usecontextlayer/shared/slate-provisioning"

export type BuildBindings = CiBindings & {
	CTX_DISPATCH_NAMESPACE: string
	DATABASES: DurableObjectNamespace<SlateDatabase>
	PROVISIONING: {
		prepare(slateId: string, commit: string): Promise<SlateProvisioning>
		migrate(prepared: SlateProvisioning, restore?: DirectoryBackup): Promise<void>
		provisionSchedules(prepared: SlateProvisioning): Promise<void>
	}
}
