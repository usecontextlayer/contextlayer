import { Composio } from "@composio/core"
import type { z } from "zod"
import { connectionLinkSchema, connectionSchema } from "@/connections.schema"

export async function authorizeConnection(
	apiKey: string,
	userId: string,
	toolkit: string,
) {
	const composio = new Composio({ apiKey })
	const session = await composio.create(userId)
	const request = await session.authorize(toolkit)
	return connectionLinkSchema.parse({ redirect_url: request.redirectUrl })
}

export async function listConnections(apiKey: string, userId: string) {
	const composio = new Composio({ apiKey })
	const connections: z.infer<typeof connectionSchema>[] = []
	let cursor: string | undefined
	do {
		const page = await composio.connectedAccounts.list({ cursor, userIds: [userId] })
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
	return { connections }
}
