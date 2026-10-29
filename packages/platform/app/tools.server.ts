import { Composio } from "@composio/core"
import type { z } from "zod"
import { createAccountSession, listPersonalAccounts } from "@/accounts.server"
import type { OwnerIdentity } from "@/auth.server"
import { checkSlateBilling } from "@/billing.server"
import type { PlatformEnv } from "@/context"
import type { PlatformDb } from "@/database"
import type { PlatformConfig } from "@/env"
import { readLatestSlateDeclarations } from "@/slate-declarations.server"
import { resolveSlateConnection } from "@/slate-resource-execution.server"
import { getSlate, type SlateAccess } from "@/slates.server"
import type {
	accountToolCallSchema,
	accountToolSessionRequestSchema,
	toolCallSchema,
} from "@/tools.schema"

export async function callTool(
	db: PlatformDb,
	artifacts: Artifacts,
	memberProvisioning: PlatformEnv["Bindings"]["MEMBER_PROVISIONING"],
	config: PlatformConfig,
	access: SlateAccess,
	call: z.infer<typeof toolCallSchema>,
) {
	const snapshot = await readLatestSlateDeclarations(artifacts, access.slate.id)
	if (!snapshot.allowed) return { allowed: false, reason: "not-declared" } as const
	const resolved = await resolveSlateConnection(
		db,
		memberProvisioning,
		config,
		access,
		call.slug,
		snapshot,
	)
	if (!resolved.allowed) return resolved
	const session = await createAccountSession(
		config.COMPOSIO_API_KEY,
		resolved.owner,
		resolved.account_id,
		resolved.requirement.toolkit,
	)
	return {
		allowed: true,
		result: await session.execute(call.tool, call.arguments),
	} as const
}

async function getPersonalAccountToolAccess(
	db: PlatformDb,
	config: PlatformConfig,
	identity: OwnerIdentity,
	accountId: string,
	input: z.infer<typeof accountToolSessionRequestSchema>,
) {
	const access = await getSlate(
		db,
		{ id: input.slate_id },
		identity,
		config.CTX_AUTH_ISSUER,
	)
	if (!access.allowed) return access
	const billing = await checkSlateBilling(db, config, access.slate)
	if (!billing.allowed) return billing
	const { accounts } = await listPersonalAccounts(config, identity, input.toolkit)
	if (!accounts.some((account) => account.id === accountId))
		return { allowed: false, reason: "forbidden" } as const
	return { allowed: true, slate: access.slate } as const
}

export async function createPersonalAccountToolSession(
	db: PlatformDb,
	config: PlatformConfig,
	identity: OwnerIdentity,
	accountId: string,
	input: z.infer<typeof accountToolSessionRequestSchema>,
) {
	const access = await getPersonalAccountToolAccess(
		db,
		config,
		identity,
		accountId,
		input,
	)
	if (!access.allowed) return access
	const session = await createAccountSession(
		config.COMPOSIO_API_KEY,
		{ id: identity.user.id, type: "personal" },
		accountId,
		input.toolkit,
	)
	return { ...access, session } as const
}

async function resolvePersonalAccountToolSession(
	db: PlatformDb,
	config: PlatformConfig,
	identity: OwnerIdentity,
	accountId: string,
	sessionId: string,
	input: z.infer<typeof accountToolSessionRequestSchema>,
) {
	const access = await getPersonalAccountToolAccess(
		db,
		config,
		identity,
		accountId,
		input,
	)
	if (!access.allowed) return access
	const composio = new Composio({ apiKey: config.COMPOSIO_API_KEY })
	const session = await composio.use(sessionId)
	const policy = session.config
	const accounts = policy.connected_accounts?.[input.toolkit]
	if (
		policy.user_id !== identity.user.id ||
		!policy.toolkits ||
		!("enabled" in policy.toolkits) ||
		policy.toolkits.enabled.length !== 1 ||
		policy.toolkits.enabled[0] !== input.toolkit ||
		Object.keys(policy.connected_accounts ?? {}).length !== 1 ||
		accounts?.length !== 1 ||
		accounts[0] !== accountId ||
		policy.manage_connections?.enabled !== false
	)
		return { allowed: false, reason: "forbidden" } as const
	return { ...access, composio, session } as const
}

export async function listPersonalAccountSessionTools(
	db: PlatformDb,
	config: PlatformConfig,
	identity: OwnerIdentity,
	accountId: string,
	sessionId: string,
	input: z.infer<typeof accountToolSessionRequestSchema>,
) {
	const resolved = await resolvePersonalAccountToolSession(
		db,
		config,
		identity,
		accountId,
		sessionId,
		input,
	)
	if (!resolved.allowed) return resolved
	return {
		allowed: true,
		tools: await resolved.composio.tools.getRawToolRouterSessionTools(
			resolved.session.sessionId,
		),
	} as const
}

export async function callPersonalAccountSessionTool(
	db: PlatformDb,
	config: PlatformConfig,
	identity: OwnerIdentity,
	accountId: string,
	sessionId: string,
	call: z.infer<typeof accountToolCallSchema>,
) {
	const resolved = await resolvePersonalAccountToolSession(
		db,
		config,
		identity,
		accountId,
		sessionId,
		call,
	)
	if (!resolved.allowed) return resolved
	return {
		allowed: true,
		result: await resolved.session.execute(call.tool, call.arguments),
		slate: resolved.slate,
	} as const
}

export async function callAccountTool(
	db: PlatformDb,
	config: PlatformConfig,
	identity: OwnerIdentity,
	accountId: string,
	call: z.infer<typeof accountToolCallSchema>,
) {
	const prepared = await createPersonalAccountToolSession(
		db,
		config,
		identity,
		accountId,
		call,
	)
	if (!prepared.allowed) return prepared
	return {
		allowed: true,
		result: await prepared.session.execute(call.tool, call.arguments),
		slate: prepared.slate,
	} as const
}
