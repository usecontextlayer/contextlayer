import { Composio } from "@composio/core"
import type { z } from "zod"
import { accountLinkSchema, accountSchema } from "@/accounts.schema"
import type { OwnerIdentity } from "@/auth.server"
import type { PlatformConfig } from "@/env"
import type { Owner } from "@/owner"
import { authorizeOwner } from "@/owner.server"

export async function createAccountSession(
	apiKey: string,
	owner: Owner,
	accountId: string,
	toolkit: string,
) {
	const composio = new Composio({ apiKey })
	return composio.create(owner.id, {
		connectedAccounts: { [toolkit]: [accountId] },
		manageConnections: { enable: false },
		sandbox: { enable: true },
		sessionPreset: "direct_tools",
		toolkits: [toolkit],
	})
}

export async function connectAccount(
	config: PlatformConfig,
	identity: OwnerIdentity,
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
		link: accountLinkSchema.parse({ redirect_url: request.redirectUrl }),
	} as const
}

async function listConnectedAccounts(apiKey: string, ownerId: string, toolkit?: string) {
	const composio = new Composio({ apiKey })
	const accounts: z.infer<typeof accountSchema>[] = []
	let cursor: string | undefined
	do {
		const page = await composio.connectedAccounts.list({
			cursor,
			statuses: ["ACTIVE"],
			toolkitSlugs: toolkit === undefined ? undefined : [toolkit],
			userIds: [ownerId],
		})
		for (const account of page.items) {
			accounts.push(
				accountSchema.parse({
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
	return accounts
}

export async function listAccounts(
	config: PlatformConfig,
	identity: OwnerIdentity,
	owner: Owner,
) {
	if (!(await authorizeOwner(identity, config.CTX_AUTH_ISSUER, owner)))
		return { allowed: false } as const
	return {
		accounts: await listConnectedAccounts(config.COMPOSIO_API_KEY, owner.id),
		allowed: true,
	} as const
}

export async function listPersonalAccounts(
	config: PlatformConfig,
	identity: OwnerIdentity,
	toolkit: string,
) {
	return {
		accounts: await listConnectedAccounts(
			config.COMPOSIO_API_KEY,
			identity.user.id,
			toolkit,
		),
	}
}

export async function listToolkits(config: PlatformConfig, slugs: string[]) {
	const composio = new Composio({ apiKey: config.COMPOSIO_API_KEY })
	const toolkits = await composio.toolkits.getMany(slugs)
	return toolkits.map(({ slug, meta }) => ({ logo: meta.logo, slug }))
}
