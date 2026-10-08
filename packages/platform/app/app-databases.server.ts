import type { databaseQuerySchema } from "@usecontextlayer/shared/databases"
import { resourcesForConsumer } from "@usecontextlayer/shared/slate"
import type { z } from "zod"
import { readAppDeclarations } from "@/app-declarations.server"
import { getAppActor } from "@/app-members.server"
import { prepareAppDatabase, resolveAppResourceActor } from "@/app-resources.server"
import type { AppAccess } from "@/apps.server"
import type { PlatformEnv } from "@/context"
import type { PlatformDb } from "@/database"

export async function queryAppDatabase(
	db: PlatformDb,
	artifacts: Artifacts,
	databases: PlatformEnv["Bindings"]["DATABASES"],
	{ app, identity }: AppAccess,
	input: z.infer<typeof databaseQuerySchema>,
) {
	const snapshot = await readAppDeclarations(artifacts, app.id)
	if (snapshot.state === "no-commit")
		return { allowed: false, reason: "not-declared" } as const
	const selected = resourcesForConsumer(snapshot.resources, { type: "app" })
	const requirement = selected.databases[input.slug]
	if (!requirement) return { allowed: false, reason: "not-declared" } as const
	const requirements = { [input.slug]: requirement }
	const actor = await getAppActor(db, app.id, identity.user)
	const resolved = resolveAppResourceActor(actor, {
		connections: {},
		databases: requirements,
		secrets: {},
	})
	if (!resolved.allowed) return resolved
	const database = prepareAppDatabase(app, resolved.viewer, input.slug, requirement)
	return {
		allowed: true,
		result: await databases
			.getByName(database.instance_name)
			.query(input.sql, input.params),
	} as const
}
