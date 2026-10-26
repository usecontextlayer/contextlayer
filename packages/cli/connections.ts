import { isCancel, select } from "@clack/prompts"
import { accountsSchema } from "@usecontextlayer/shared/accounts"
import { slateConnectionsSchema } from "@usecontextlayer/shared/slate-connections"
import { noCommitSchema } from "@usecontextlayer/shared/slate-resources"
import { z } from "zod"
import { getAccessToken } from "@/auth"
import { env } from "@/env"
import { prepareLocalResourceConfiguration, saveLocalConnection } from "@/resources"

export const connectionsCommandSchema = z.discriminatedUnion("operation", [
	z.object({
		account_id: z.undefined(),
		operation: z.literal("list"),
		slug: z.undefined(),
		target: z.string().min(1),
	}),
	z
		.object({
			account_id: z.string().min(1).optional(),
			operation: z.literal("assign"),
			slug: z.string().min(1),
			target: z.string().min(1),
		})
		.superRefine((input, ctx) => {
			if (input.target !== "local" && input.account_id === undefined) {
				ctx.addIssue({
					code: "custom",
					message: "Hosted assignment requires an account ID",
					path: ["account_id"],
				})
			}
		}),
])

export async function assignSlateConnection(
	target: string,
	slug: string,
	accountId: string | undefined,
) {
	if (target === "local") {
		const configuration = await prepareLocalResourceConfiguration()
		const requirement = new Map(Object.entries(configuration.connections)).get(slug)
		if (!requirement) throw new Error(`No local connection requirement for "${slug}"`)
		if (accountId === undefined && !process.stdin.isTTY) {
			throw new Error("Supply an account ID when assigning without a terminal")
		}
		const url = new URL("/api/accounts", env.CTX_PLATFORM_URL)
		url.searchParams.set("toolkit", requirement.toolkit)
		const response = await fetch(url, {
			headers: { authorization: `Bearer ${await getAccessToken(env)}` },
		})
		if (!response.ok)
			throw new Error(`Personal connected account list failed: HTTP ${response.status}`)
		const { accounts } = accountsSchema.parse(await response.json())
		if (accounts.length === 0)
			throw new Error(
				`No personal connected accounts for ${requirement.toolkit}. Run npx @usecontextlayer/cli accounts add ${requirement.toolkit} to connect an account in your browser, then rerun this assignment.`,
			)
		if (accountId === undefined) {
			const selectedAccountId = await select({
				message: `Assign a connected ${requirement.toolkit} account to ${slug}`,
				options: accounts.map((account) => ({
					label: `${account.display_name ?? account.alias ?? account.id} (${account.id}; ${account.status})`,
					value: account.id,
				})),
				output: process.stderr,
			})
			if (isCancel(selectedAccountId)) {
				process.exitCode = 130
				return
			}
			accountId = selectedAccountId
		}
		if (!accounts.some(({ id }) => id === accountId)) {
			throw new Error(
				`Connected account ${accountId} is not one of your connected ${requirement.toolkit} accounts`,
			)
		}
		await saveLocalConnection(slug, accountId)
		console.log(`${slug} → ${accountId}`)
		console.log("Start or restart pnpm dev to use this assignment.")
		return
	}
	const response = await fetch(
		new URL(
			`/api/slates/${encodeURIComponent(target)}/connections/assign`,
			env.CTX_PLATFORM_URL,
		),
		{
			body: JSON.stringify({ account_id: accountId, slug }),
			headers: {
				authorization: `Bearer ${await getAccessToken(env)}`,
				"content-type": "application/json",
			},
			method: "POST",
		},
	)
	if (response.status === 409 && noCommitSchema.safeParse(await response.json()).success)
		throw new Error(
			"Nothing has been pushed to this slate yet. Push to main before configuring hosted resources.",
		)
	if (!response.ok)
		throw new Error(`Connection assignment failed: HTTP ${response.status}`)
	const assignment = z
		.object({ account_id: z.string(), slug: z.string() })
		.parse(await response.json())
	console.log(`${assignment.slug} → ${assignment.account_id}`)
}

async function prepareSlateConnections(target: string) {
	if (target === "local") {
		const { connections } = await prepareLocalResourceConfiguration()
		return Object.entries(connections).map(([slug, connection]) => ({
			...connection,
			slug,
		}))
	}
	const response = await fetch(
		new URL(
			`/api/slates/${encodeURIComponent(target)}/connections/list`,
			env.CTX_PLATFORM_URL,
		),
		{
			body: JSON.stringify({}),
			headers: {
				authorization: `Bearer ${await getAccessToken(env)}`,
				"content-type": "application/json",
			},
			method: "POST",
		},
	)
	if (response.status === 409 && noCommitSchema.safeParse(await response.json()).success)
		throw new Error(
			"Nothing has been pushed to this slate yet. Push to main before configuring hosted resources.",
		)
	if (!response.ok)
		throw new Error(`Slate connections request failed: HTTP ${response.status}`)
	return slateConnectionsSchema.parse(await response.json()).connections
}

export async function listSlateConnections(target: string) {
	const connections = await prepareSlateConnections(target)
	if (!connections.length) {
		console.log("No connection requirements.")
		return
	}
	console.table(
		connections.map(({ account_id, consumers, ...requirement }) => ({
			...requirement,
			connected_account: account_id ?? "unassigned",
			consumers: consumers
				.map((consumer) => (consumer.type === "app" ? "app" : `agent:${consumer.name}`))
				.join(", "),
		})),
	)
}
