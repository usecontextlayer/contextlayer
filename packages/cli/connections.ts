import { isCancel, select } from "@clack/prompts"
import { appConnectionsSchema } from "@usecontextlayer/shared/app-connections"
import { connectionsSchema } from "@usecontextlayer/shared/connections"
import { z } from "zod"
import { getAccessToken } from "@/auth"
import { env } from "@/env"
import { ownerPath, resolveOwner } from "@/owner"
import { prepareLocalResourceConfiguration, saveLocalConnection } from "@/resources"

export const connectionAssignmentSchema = z
	.object({
		connection_id: z.string().min(1).optional(),
		slug: z.string().min(1),
		target: z.string().min(1),
	})
	.superRefine((input, ctx) => {
		if (input.target !== "local" && input.connection_id === undefined) {
			ctx.addIssue({
				code: "custom",
				message: "Hosted assignment requires a connection ID",
				path: ["connection_id"],
			})
		}
	})

export async function assignAppConnection(
	target: string,
	slug: string,
	connectionId: string | undefined,
) {
	if (target === "local") {
		const configuration = await prepareLocalResourceConfiguration()
		const requirement = new Map(Object.entries(configuration.connections)).get(slug)
		if (!requirement) throw new Error(`No local connection requirement for "${slug}"`)
		if (connectionId === undefined && !process.stdin.isTTY) {
			throw new Error("Supply a connection ID when assigning without a terminal")
		}
		const url = new URL("/api/connections", env.CTX_PLATFORM_URL)
		url.searchParams.set("toolkit", requirement.toolkit)
		const response = await fetch(url, {
			headers: { authorization: `Bearer ${await getAccessToken()}` },
		})
		if (!response.ok)
			throw new Error(`Personal connection list failed: HTTP ${response.status}`)
		const { connections } = connectionsSchema.parse(await response.json())
		if (connections.length === 0)
			throw new Error(
				`No personal ${requirement.toolkit} accounts. Run npx @usecontextlayer/cli connections add ${requirement.toolkit}, approve access in your browser, then rerun this assignment.`,
			)
		if (connectionId === undefined) {
			const selected = await select({
				message: `Your ${requirement.toolkit} account for ${slug}`,
				options: connections.map((connection) => ({
					label: `${connection.display_name ?? connection.alias ?? connection.id} (${connection.id}; ${connection.status})`,
					value: connection.id,
				})),
				output: process.stderr,
			})
			if (isCancel(selected)) {
				process.exitCode = 130
				return
			}
			connectionId = selected
		}
		if (!connections.some(({ id }) => id === connectionId)) {
			throw new Error(
				`Account ${connectionId} is not one of your ${requirement.toolkit} accounts`,
			)
		}
		await saveLocalConnection(slug, connectionId)
		console.log(`${slug} → ${connectionId}`)
		console.log("Start or restart pnpm dev to use this assignment.")
		return
	}
	const response = await fetch(
		new URL(
			`/api/apps/${encodeURIComponent(target)}/connections/assign`,
			env.CTX_PLATFORM_URL,
		),
		{
			body: JSON.stringify({ connection_id: connectionId, slug }),
			headers: {
				authorization: `Bearer ${await getAccessToken()}`,
				"content-type": "application/json",
			},
			method: "POST",
		},
	)
	if (!response.ok)
		throw new Error(`Connection assignment failed: HTTP ${response.status}`)
	const assignment = z
		.object({ connection_id: z.string(), slug: z.string() })
		.parse(await response.json())
	console.log(`${assignment.slug} → ${assignment.connection_id}`)
}

export async function listAppConnections(target: string) {
	if (target === "local") {
		const { connections } = await prepareLocalResourceConfiguration()
		if (Object.keys(connections).length === 0) {
			console.log("No connection requirements.")
			return
		}
		console.table(
			Object.entries(connections).map(
				([slug, { connection_id, consumers, mode, toolkit }]) => ({
					connection: connection_id ?? "unassigned",
					consumers: consumers
						.map((consumer) =>
							consumer.type === "app" ? "app" : `agent:${consumer.name}`,
						)
						.join(", "),
					mode,
					slug,
					toolkit,
				}),
			),
		)
		return
	}
	const response = await fetch(
		new URL(
			`/api/apps/${encodeURIComponent(target)}/connections/list`,
			env.CTX_PLATFORM_URL,
		),
		{
			body: JSON.stringify({}),
			headers: {
				authorization: `Bearer ${await getAccessToken()}`,
				"content-type": "application/json",
			},
			method: "POST",
		},
	)
	if (!response.ok)
		throw new Error(`App connections request failed: HTTP ${response.status}`)
	const { connections } = appConnectionsSchema.parse(await response.json())
	if (!connections.length) {
		console.log("No connection requirements.")
		return
	}
	console.table(
		connections.map(({ connection_id, ...requirement }) => ({
			...requirement,
			connection: connection_id ?? "unassigned",
		})),
	)
}

export async function addConnection(toolkit: string, org: string | undefined) {
	const headers = { authorization: `Bearer ${await getAccessToken()}` }
	const owner = await resolveOwner(org, headers)
	const response = await fetch(
		new URL(`/api/connections/${ownerPath(owner)}`, env.CTX_PLATFORM_URL),
		{
			body: JSON.stringify({ toolkit }),
			headers: {
				...headers,
				"content-type": "application/json",
			},
			method: "POST",
		},
	)
	if (!response.ok)
		throw new Error(`Connection authorization failed: HTTP ${response.status}`)
	const { redirect_url } = z
		.object({ redirect_url: z.url() })
		.parse(await response.json())
	console.log(`Open this link to authorize the Owner's account:\n${redirect_url}`)
	console.log(
		"After approving access in your browser, assign the account to an app's declared connection slug.",
	)
	if (!org) {
		console.log(
			"From your app directory, choose your account for a slug in public/slate.json:\n  npx @usecontextlayer/cli connection local assign <slug>",
		)
	}
	console.log(
		`For a hosted app, get the account ID and assign it:\n  npx @usecontextlayer/cli connections${org ? ` --org '${org.replaceAll("'", "'\\''")}'` : ""} list\n  npx @usecontextlayer/cli connection <AppID-or-hostname> assign <slug> <connection_id>`,
	)
}

export async function listConnections(org: string | undefined) {
	const headers = { authorization: `Bearer ${await getAccessToken()}` }
	const owner = await resolveOwner(org, headers)
	const response = await fetch(
		new URL(`/api/connections/${ownerPath(owner)}`, env.CTX_PLATFORM_URL),
		{
			headers,
		},
	)
	if (!response.ok) throw new Error(`Connection list failed: HTTP ${response.status}`)
	const { connections } = connectionsSchema.parse(await response.json())
	if (connections.length === 0) {
		console.log("No connected accounts.")
		return
	}
	console.table(connections)
}
