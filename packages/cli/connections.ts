import { readFile } from "node:fs/promises"
import { z } from "zod"
import { getLocalAppId } from "@/app"
import { getAccessToken } from "@/auth"
import { env } from "@/env"

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
	const appTarget = await resolveAppTarget(target)
	const manifest: unknown =
		target === "local"
			? JSON.parse(await readFile("public/slate.json", "utf8"))
			: undefined
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
					mode: z.enum(["individual", "shared"]),
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

export async function addConnection(toolkit: string) {
	const response = await fetch(new URL("/api/connections", env.CTX_PLATFORM_URL), {
		body: JSON.stringify({ toolkit }),
		headers: {
			authorization: `Bearer ${await getAccessToken()}`,
			"content-type": "application/json",
		},
		method: "POST",
	})
	if (!response.ok)
		throw new Error(`Connection authorization failed: HTTP ${response.status}`)
	const { redirect_url } = z
		.object({ redirect_url: z.url() })
		.parse(await response.json())
	console.log(`Open this link to connect your account:\n${redirect_url}`)
	console.log("After authorization, run ctx connections list to see your account.")
}

export async function listConnections() {
	const response = await fetch(new URL("/api/connections", env.CTX_PLATFORM_URL), {
		headers: { authorization: `Bearer ${await getAccessToken()}` },
	})
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
