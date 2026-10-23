import type { z } from "zod"
import type { OwnerIdentity } from "@/auth.server"
import { checkSlateBilling } from "@/billing.server"
import { createConnectionSession } from "@/connections.server"
import type { PlatformEnv } from "@/context"
import type { PlatformDb } from "@/database"
import type { PlatformConfig } from "@/env"
import { readLatestSlateDeclarations } from "@/slate-declarations.server"
import { resolveSlateConnection } from "@/slate-resource-execution.server"
import { getSlate, type SlateAccess } from "@/slates.server"
import type { connectionToolCallSchema, toolCallSchema } from "@/tools.schema"

export async function callTool(
	db: PlatformDb,
	artifacts: Artifacts,
	sandbox: PlatformEnv["Bindings"]["SANDBOX"],
	agents: PlatformEnv["Bindings"]["AGENTS"],
	config: PlatformConfig,
	access: SlateAccess,
	call: z.infer<typeof toolCallSchema>,
) {
	const snapshot = await readLatestSlateDeclarations(artifacts, access.slate.id)
	if (!snapshot.allowed) return { allowed: false, reason: "not-declared" } as const
	const resolved = await resolveSlateConnection(
		db,
		artifacts,
		sandbox,
		agents,
		config,
		access,
		call.slug,
		snapshot,
	)
	if (!resolved.allowed) return resolved
	const session = await createConnectionSession(
		config.COMPOSIO_API_KEY,
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
	identity: OwnerIdentity,
	connectionId: string,
	call: z.infer<typeof connectionToolCallSchema>,
) {
	const access = await getSlate(
		db,
		{ id: call.slate_id },
		identity,
		config.CTX_AUTH_ISSUER,
	)
	if (!access.allowed) return access
	const billing = await checkSlateBilling(db, config, access.slate)
	if (!billing.allowed) return billing
	const session = await createConnectionSession(
		config.COMPOSIO_API_KEY,
		{ id: identity.user.id, type: "personal" },
		connectionId,
		call.toolkit,
	)
	return {
		allowed: true,
		result: await session.execute(call.tool, call.arguments),
		slate: access.slate,
	} as const
}
