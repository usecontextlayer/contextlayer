import { credentialModeSchema } from "@usecontextlayer/shared/slate"
import { z } from "zod"
import { getLocalAppId, readLocalManifest } from "@/app"
import { getAccessToken } from "@/auth"
import { env } from "@/env"
import { ownerPath, resolveOwner } from "@/owner"

async function getLocalManifest(target: string) {
	return target === "local" ? readLocalManifest() : undefined
}

async function resolveAppTarget(target: string) {
	if (target !== "local") return target
	return getLocalAppId()
}

export async function assignAppConnection(
	target: string,
	slug: string,
	connectionId: string,
) {
	const appTarget = await resolveAppTarget(target)
	const response = await fetch(
		new URL(
			`/api/apps/${encodeURIComponent(appTarget)}/connections/assign`,
			env.CTX_PLATFORM_URL,
		),
		{
			body: JSON.stringify({
				connection_id: connectionId,
				manifest: await getLocalManifest(target),
				slug,
			}),
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
	const appTarget = await resolveAppTarget(target)
	const manifest = await getLocalManifest(target)
	const response = await fetch(
		new URL(
			`/api/apps/${encodeURIComponent(appTarget)}/connections/list`,
			env.CTX_PLATFORM_URL,
		),
		{
			body: JSON.stringify({ manifest }),
			headers: {
				authorization: `Bearer ${await getAccessToken()}`,
				"content-type": "application/json",
			},
			method: "POST",
		},
	)
	if (!response.ok)
		throw new Error(`App connections request failed: HTTP ${response.status}`)
	const { connections } = z
		.object({
			connections: z.array(
				z.object({
					connection_id: z.string().nullable(),
					mode: credentialModeSchema,
					slug: z.string(),
					toolkit: z.string(),
				}),
			),
		})
		.parse(await response.json())
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
		`After authorization, run ctx connections${org ? ` --org ${org}` : ""} list to see the Owner's account.`,
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
	const { connections } = z
		.object({
			connections: z.array(
				z.object({
					alias: z.string().nullable(),
					display_name: z.string().nullable(),
					id: z.string(),
					status: z.string(),
					toolkit: z.string(),
				}),
			),
		})
		.parse(await response.json())
	if (connections.length === 0) {
		console.log("No connected accounts.")
		return
	}
	console.table(connections)
}
