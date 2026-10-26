import { WorkerEntrypoint } from "cloudflare:workers"
import { createPolarCore } from "@polar-sh/sdk/2026-10"
import { databaseQuerySchema } from "@usecontextlayer/shared/databases"
import { recordSlateUsage } from "@usecontextlayer/shared/slate-usage"
import type { HostedExecution } from "@usecontextlayer/shared/tools-worker"
import { authenticateSession } from "@/auth.server"
import { checkSlateBilling } from "@/billing.server"
import type { PlatformEnv } from "@/context"
import { createPlatformDb, type PlatformDb } from "@/database"
import { type PlatformConfig, parsePlatformEnv } from "@/env"
import { getSlateOwner } from "@/owner"
import { querySlateDatabase } from "@/slate-databases.server"
import { slateSchema } from "@/slates.schema"
import { resolveSlateForViewing } from "@/slates.server"
import { toolCallSchema } from "@/tools.schema"
import { callTool } from "@/tools.server"

async function getViewerAccess(
	db: PlatformDb,
	config: PlatformConfig,
	slateId: string,
	viewerSessionToken: string,
) {
	const id = slateSchema.shape.id.parse(slateId)
	const credential = { token: viewerSessionToken, type: "session" } as const
	const identity = await authenticateSession(credential, config.CTX_AUTH_ISSUER)
	if (!identity) return { allowed: false, reason: "sign-in-required" } as const
	const access = await resolveSlateForViewing(
		db,
		{ id },
		identity,
		config.CTX_AUTH_ISSUER,
	)
	if (!access.allowed) return access
	const billing = await checkSlateBilling(db, config, access.slate)
	if (!billing.allowed) return billing
	return { allowed: true, identity, slate: access.slate } as const
}

export class Execution
	extends WorkerEntrypoint<PlatformEnv["Bindings"]>
	implements HostedExecution
{
	async callTool(
		slateId: string,
		viewerSessionToken: string,
		input: Parameters<HostedExecution["callTool"]>[2],
	) {
		const call = toolCallSchema.parse(input)
		const config = parsePlatformEnv(this.env)
		const db = createPlatformDb(config.CTX_PLATFORM_DATABASE_URL)
		try {
			const access = await getViewerAccess(db, config, slateId, viewerSessionToken)
			if (!access.allowed) return access
			const result = await callTool(
				db,
				this.env.ARTIFACTS,
				this.env.MEMBER_PROVISIONING,
				config,
				access,
				call,
			)
			if (!result.allowed) return result
			this.ctx.waitUntil(
				recordSlateUsage(
					createPolarCore({
						accessToken: config.POLAR_ACCESS_TOKEN,
						environment: config.POLAR_ENVIRONMENT,
					}),
					{ id: access.slate.id, owner: getSlateOwner(access.slate) },
					"tool_call",
				),
			)
			return result
		} finally {
			await db.destroy()
		}
	}

	async queryDatabase(
		slateId: string,
		viewerSessionToken: string,
		input: Parameters<HostedExecution["queryDatabase"]>[2],
	) {
		const query = databaseQuerySchema.parse(input)
		const config = parsePlatformEnv(this.env)
		const db = createPlatformDb(config.CTX_PLATFORM_DATABASE_URL)
		try {
			const access = await getViewerAccess(db, config, slateId, viewerSessionToken)
			if (!access.allowed) return access
			return await querySlateDatabase(
				db,
				this.env.ARTIFACTS,
				this.env.DATABASES,
				this.env.MEMBER_PROVISIONING,
				config,
				access,
				query,
			)
		} finally {
			await db.destroy()
		}
	}
}
