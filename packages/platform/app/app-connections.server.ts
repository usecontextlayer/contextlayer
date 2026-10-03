import type { z } from "zod"
import { type assignmentSchema, slateSchema } from "@/app-connections.schema"
import type { AppAccess } from "@/apps.server"
import { credentialHeaders } from "@/auth.server"
import type { PlatformDb } from "@/database"
import type { AppConnectionAssignmentUserId } from "@/database/models/public/AppConnectionAssignment"

export async function assignAppConnection(
	db: PlatformDb,
	{ app, identity }: AppAccess,
	assignment: z.infer<typeof assignmentSchema>,
) {
	return db
		.insertInto("app_connection_assignment")
		.values({
			app_id: app.id,
			user_id: identity.user.id as AppConnectionAssignmentUserId,
			...assignment,
		})
		.onConflict((conflict) =>
			conflict
				.columns(["app_id", "user_id", "slug"])
				.doUpdateSet({ connection_id: assignment.connection_id }),
		)
		.returning(["slug", "connection_id"])
		.executeTakeFirstOrThrow()
}

export async function listAppConnections(
	db: PlatformDb,
	{ app, identity }: AppAccess,
	localManifest?: z.infer<typeof slateSchema>,
) {
	let manifest = localManifest
	if (!manifest) {
		const response = await fetch(`https://${app.public_hostname}/slate.json`, {
			headers: credentialHeaders(identity.credential),
		})
		if (!response.ok)
			throw new Error(`App manifest request failed: HTTP ${response.status}`)
		manifest = slateSchema.parse(await response.json())
	}
	const rows = await db
		.selectFrom("app_connection_assignment")
		.select(["slug", "connection_id"])
		.where("app_id", "=", app.id)
		.where("user_id", "=", identity.user.id as AppConnectionAssignmentUserId)
		.execute()
	const assignments = new Map<string, string>(
		rows.map((row) => [row.slug, row.connection_id]),
	)
	return {
		app,
		connections: Object.entries(manifest.connections).map(([slug, requirement]) => ({
			slug,
			...requirement,
			connection_id:
				requirement.mode === "individual" ? (assignments.get(slug) ?? null) : null,
		})),
	}
}
