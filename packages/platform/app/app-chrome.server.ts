import { type ActionFunctionArgs, data, type HeadersFunction } from "react-router"
import { z } from "zod"
import { assignmentSchema } from "@/app-connections.schema"
import { assignAppConnection } from "@/app-connections.server"
import { getAppResources, listAppConnections } from "@/app-resources.server"
import { type AppTarget, appTargetSchema } from "@/apps.schema"
import { resolveAppForViewing } from "@/apps.server"
import { type AuthIdentity, getCurrentUser } from "@/auth.server"
import { authorizeConnection, listConnections, listToolkits } from "@/connections.server"
import {
	artifactsContext,
	configContext,
	databaseContext,
	identityContext,
} from "@/context"
import type { PlatformDb } from "@/database"
import type { PlatformConfig } from "@/env"
import { getCredentialOwner } from "@/owner"

const chromeActionSchema = z.discriminatedUnion("intent", [
	assignmentSchema.extend({ intent: z.literal("assign") }),
	assignmentSchema.pick({ slug: true }).extend({ intent: z.literal("connect") }),
])

async function getChromeApp(
	db: PlatformDb,
	config: PlatformConfig,
	artifacts: Artifacts,
	target: AppTarget,
	identity: AuthIdentity,
) {
	const result = await resolveAppForViewing(db, target, identity, config.CTX_AUTH_ISSUER)
	if (!result.allowed) return result
	const access = { app: result.app, identity }
	const resources = await getAppResources(access, artifacts)
	return { access, allowed: true, resources } as const
}

export async function getAppChrome(
	db: PlatformDb,
	config: PlatformConfig,
	artifacts: Artifacts,
	target: AppTarget,
	identity: AuthIdentity,
) {
	const result = await getChromeApp(db, config, artifacts, target, identity)
	if (!result.allowed) return result
	const { access, resources } = result
	const { connections } = await listAppConnections(db, access, resources)
	const accountReads = new Map<string, ReturnType<typeof listConnections>>()
	const requirements = await Promise.all(
		connections.map(async (requirement) => {
			const owner = requirement.owner
			const key = `${owner.type}:${owner.id}`
			let accountAccess = accountReads.get(key)
			if (!accountAccess) {
				accountAccess = listConnections(config, identity, owner)
				accountReads.set(key, accountAccess)
			}
			return { ...requirement, accountAccess: await accountAccess }
		}),
	)
	const [user, toolkits] = await Promise.all([
		getCurrentUser(identity, config.CTX_AUTH_ISSUER),
		requirements.length
			? listToolkits(config, [...new Set(requirements.map(({ toolkit }) => toolkit))])
			: [],
	])
	return {
		allowed: true,
		app: access.app,
		connections: requirements,
		toolkits,
		user,
	} as const
}

export type ChromeData = Omit<
	Extract<Awaited<ReturnType<typeof getAppChrome>>, { allowed: true }>,
	"allowed"
>

export const chromeHeaders: HeadersFunction = ({ actionHeaders }) => {
	actionHeaders.set("Cache-Control", "no-store")
	return actionHeaders
}

export async function chromeAction({ request, params, context }: ActionFunctionArgs) {
	const identity = context.get(identityContext)
	if (!identity) throw new Response(null, { status: 401 })
	const input = chromeActionSchema.safeParse(Object.fromEntries(await request.formData()))
	if (!input.success) throw new Response("Invalid connection action", { status: 400 })
	const config = context.get(configContext)
	const db = context.get(databaseContext)
	const result = await getChromeApp(
		db,
		config,
		context.get(artifactsContext),
		appTargetSchema.parse(params.target),
		identity,
	)
	if (!result.allowed)
		throw new Response(null, { status: result.reason === "not-found" ? 404 : 403 })
	const { access, resources } = result
	if (input.data.intent === "connect") {
		const requirement = resources.connections[input.data.slug]
		if (!requirement) throw new Response(null, { status: 404 })
		const authorization = await authorizeConnection(
			config,
			identity,
			getCredentialOwner(requirement.mode, access.app, identity.user),
			requirement.toolkit,
		)
		if (!authorization.allowed) throw new Response(null, { status: 403 })
		return data(null, {
			headers: { Refresh: `0; url=${authorization.link.redirect_url}` },
		})
	}
	const assignment = await assignAppConnection(
		db,
		access,
		config.CTX_AUTH_ISSUER,
		{ connection_id: input.data.connection_id, slug: input.data.slug },
		resources,
	)
	if (!assignment.allowed)
		throw new Response(null, { status: assignment.reason === "not-found" ? 404 : 403 })
	return assignment.assignment
}
