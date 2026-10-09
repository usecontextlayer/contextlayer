import type { z } from "zod"
import { readAppDeclarations } from "@/app-declarations.server"
import { resolveAppConnection } from "@/app-resources.server"
import { type AppAccess, resolveAppForViewing } from "@/apps.server"
import type { NativeAuthIdentity } from "@/auth.server"
import { checkAppBilling } from "@/billing.server"
import { createConnectionSession } from "@/connections.server"
import type { PlatformDb } from "@/database"
import type { PlatformConfig } from "@/env"
import type { connectionToolCallSchema, toolCallSchema } from "@/tools.schema"

export async function callTool(
	db: PlatformDb,
	apiKey: string,
	access: AppAccess,
	call: z.infer<typeof toolCallSchema>,
	artifacts: Artifacts,
) {
	const snapshot = await readAppDeclarations(artifacts, access.app.id)
	if (snapshot.state === "no-commit")
		return { allowed: false, reason: "not-declared" } as const
	const resolved = await resolveAppConnection(db, access, call.slug, snapshot.resources)
	if (!resolved.allowed) return resolved
	const session = await createConnectionSession(
		apiKey,
		resolved.owner,
		resolved.connection_id,
		resolved.requirement.toolkit,
	)
	return {
		allowed: true,
		result: await session.execute(call.tool, call.arguments),
	} as const
}

export async function callConnectionTool(
	db: PlatformDb,
	config: PlatformConfig,
	identity: NativeAuthIdentity,
	connectionId: string,
	call: z.infer<typeof connectionToolCallSchema>,
) {
	const access = await resolveAppForViewing(
		db,
		{ id: call.app_id },
		identity,
		config.CTX_AUTH_ISSUER,
	)
	if (!access.allowed) return access
	const billing = await checkAppBilling(db, config, access.app)
	if (!billing.allowed) return billing
	const session = await createConnectionSession(
		config.COMPOSIO_API_KEY,
		{ id: identity.user.id, type: "user" },
		connectionId,
		call.toolkit,
	)
	return {
		allowed: true,
		app: access.app,
		result: await session.execute(call.tool, call.arguments),
	} as const
}
