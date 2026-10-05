import type { z } from "zod"
import { resolveAppConnection } from "@/app-connections.server"
import type { AppAccess } from "@/apps.server"
import { createConnectionSession } from "@/connections.server"
import type { PlatformDb } from "@/database"
import type { ManifestSnapshot } from "@/manifest.server"
import type { toolCallSchema } from "@/tools.schema"

export async function callTool(
	db: PlatformDb,
	apiKey: string,
	access: AppAccess,
	issuer: string,
	call: Omit<z.infer<typeof toolCallSchema>, "manifest">,
	snapshot: ManifestSnapshot,
) {
	const resolved = await resolveAppConnection(db, access, issuer, call.slug, snapshot)
	if (!resolved.allowed) return resolved
	const session = await createConnectionSession(
		apiKey,
		resolved.owner,
		resolved.connection_id,
	)
	return {
		allowed: true,
		result: await session.execute(call.tool, call.arguments),
	} as const
}
