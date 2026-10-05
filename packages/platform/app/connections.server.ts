import { Composio } from "@composio/core"
import type { z } from "zod"
import type { AuthIdentity } from "@/auth.server"
import { connectionLinkSchema, connectionSchema } from "@/connections.schema"
import type { PlatformConfig } from "@/env"
import type { Owner } from "@/owner"
import { authorizeOwner } from "@/owner.server"

export async function authorizeConnection(
	config: PlatformConfig,
	identity: AuthIdentity,
	owner: Owner,
	toolkit: string,
) {
	if (!(await authorizeOwner(identity, config.CTX_AUTH_ISSUER, owner)))
		return { allowed: false } as const
	const composio = new Composio({ apiKey: config.COMPOSIO_API_KEY })
	const session = await composio.create(owner.id)
	const request = await session.authorize(toolkit)
	return {
		allowed: true,
		link: connectionLinkSchema.parse({ redirect_url: request.redirectUrl }),
	} as const
}

export async function listConnections(
	config: PlatformConfig,
	identity: AuthIdentity,
	owner: Owner,
) {
	if (!(await authorizeOwner(identity, config.CTX_AUTH_ISSUER, owner)))
		return { allowed: false } as const
	const composio = new Composio({ apiKey: config.COMPOSIO_API_KEY })
	const connections: z.infer<typeof connectionSchema>[] = []
	let cursor: string | undefined
	do {
		const page = await composio.connectedAccounts.list({ cursor, userIds: [owner.id] })
		for (const account of page.items) {
			connections.push(
				connectionSchema.parse({
					alias: account.alias ?? null,
					display_name: account.state?.val.displayName ?? null,
					id: account.id,
					status: account.status,
					toolkit: account.toolkit.slug,
				}),
			)
		}
		cursor = page.nextCursor ?? undefined
	} while (cursor)
	return { allowed: true, connections } as const
}

export async function listToolkits(config: PlatformConfig, slugs: string[]) {
	const composio = new Composio({ apiKey: config.COMPOSIO_API_KEY })
	const toolkits = await composio.toolkits.getMany(slugs)
	return toolkits.map(({ slug, meta }) => ({ logo: meta.logo, slug }))
}
