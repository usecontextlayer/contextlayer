import { WorkerEntrypoint } from "cloudflare:workers"
import { createPolarCore } from "@polar-sh/sdk/2026-10"
import { recordAppUsage } from "@usecontextlayer/shared/app-usage"
import { databaseQuerySchema } from "@usecontextlayer/shared/databases"
import type { HostedExecution } from "@usecontextlayer/shared/tools-worker"
import { queryAppDatabase } from "@/app-databases.server"
import { appSchema } from "@/apps.schema"
import { resolveAppForViewing } from "@/apps.server"
import { authenticateSession } from "@/auth.server"
import { checkAppBilling } from "@/billing.server"
import type { PlatformEnv } from "@/context"
import { createPlatformDb, type PlatformDb } from "@/database"
import { type PlatformConfig, parsePlatformEnv } from "@/env"
import { getAppOwner } from "@/owner"
import { toolCallSchema } from "@/tools.schema"
import { callTool } from "@/tools.server"

async function getViewerAccess(
	db: PlatformDb,
	config: PlatformConfig,
	appId: string,
	viewerSessionToken: string,
) {
	const id = appSchema.shape.id.parse(appId)
	const credential = { token: viewerSessionToken, type: "session" } as const
	const user = await authenticateSession(credential, config.CTX_AUTH_ISSUER)
	if (!user) return { allowed: false, reason: "sign-in-required" } as const
	const identity = { credential, user }
	const access = await resolveAppForViewing(db, { id }, identity, config.CTX_AUTH_ISSUER)
	if (!access.allowed) return access
	const billing = await checkAppBilling(db, config, access.app)
	if (!billing.allowed) return billing
	return { allowed: true, app: access.app, identity } as const
}

export class Execution
	extends WorkerEntrypoint<PlatformEnv["Bindings"]>
	implements HostedExecution
{
	async callTool(
		appId: string,
		viewerSessionToken: string,
		input: Parameters<HostedExecution["callTool"]>[2],
	) {
		const call = toolCallSchema.parse(input)
		const config = parsePlatformEnv(this.env)
		const db = createPlatformDb(config.CTX_PLATFORM_DATABASE_URL)
		try {
			const access = await getViewerAccess(db, config, appId, viewerSessionToken)
			if (!access.allowed) return access
			const result = await callTool(
				db,
				config.COMPOSIO_API_KEY,
				access,
				call,
				this.env.ARTIFACTS,
			)
			if (!result.allowed) return result
			this.ctx.waitUntil(
				recordAppUsage(
					createPolarCore({
						accessToken: config.POLAR_ACCESS_TOKEN,
						environment: config.POLAR_ENVIRONMENT,
					}),
					{ id: access.app.id, owner: getAppOwner(access.app) },
					"tool_call",
				),
			)
			return result
		} finally {
			await db.destroy()
		}
	}

	async queryDatabase(
		appId: string,
		viewerSessionToken: string,
		input: Parameters<HostedExecution["queryDatabase"]>[2],
	) {
		const query = databaseQuerySchema.parse(input)
		const config = parsePlatformEnv(this.env)
		const db = createPlatformDb(config.CTX_PLATFORM_DATABASE_URL)
		try {
			const access = await getViewerAccess(db, config, appId, viewerSessionToken)
			if (!access.allowed) return access
			return await queryAppDatabase(
				db,
				this.env.ARTIFACTS,
				this.env.DATABASES,
				access,
				query,
			)
		} finally {
			await db.destroy()
		}
	}
}
