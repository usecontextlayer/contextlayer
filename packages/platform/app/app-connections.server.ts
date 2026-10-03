import type { z } from "zod"
import {
	type appTargetSchema,
	type assignmentSchema,
	slateSchema,
} from "@/app-connections.schema"
import type { PlatformDb } from "@/database"
import type { AppConnectionAssignmentUserId } from "@/database/models/public/AppConnectionAssignment"

function findApp(db: PlatformDb, target: z.infer<typeof appTargetSchema>) {
	let query = db.selectFrom("app").selectAll()
	query =
		"id" in target
			? query.where("id", "=", target.id)
			: query.where("public_hostname", "=", target.public_hostname)
	return query.executeTakeFirst()
}

export async function assignAppConnection(
	db: PlatformDb,
	target: z.infer<typeof appTargetSchema>,
	userId: string,
	assignment: z.infer<typeof assignmentSchema>,
) {
	const app = await findApp(db, target)
	if (!app) return null
	return db
		.insertInto("app_connection_assignment")
		.values({
			app_id: app.id,
			user_id: userId as AppConnectionAssignmentUserId,
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
	target: z.infer<typeof appTargetSchema>,
	userId: string,
	localManifest?: z.infer<typeof slateSchema>,
) {
	const app = await findApp(db, target)
	if (!app) return null
	let manifest = localManifest
	if (!manifest) {
		const response = await fetch(`https://${app.public_hostname}/slate.json`)
		if (!response.ok)
			throw new Error(`App manifest request failed: HTTP ${response.status}`)
		manifest = slateSchema.parse(await response.json())
	}
	const rows = await db
		.selectFrom("app_connection_assignment")
		.select(["slug", "connection_id"])
		.where("app_id", "=", app.id)
		.where("user_id", "=", userId as AppConnectionAssignmentUserId)
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
