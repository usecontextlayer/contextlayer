import type { databaseQuerySchema } from "@usecontextlayer/shared/databases"
import { resourcesForConsumer } from "@usecontextlayer/shared/declaration"
import type { z } from "zod"
import type { PlatformEnv } from "@/context"
import type { PlatformDb } from "@/database"
import { readSlateDeclarations } from "@/slate-declarations.server"
import { getSlateActor } from "@/slate-members.server"
import { prepareSlateDatabase, resolveSlateResourceActor } from "@/slate-resources.server"
import type { SlateAccess } from "@/slates.server"

export async function querySlateDatabase(
	db: PlatformDb,
	artifacts: Artifacts,
	databases: PlatformEnv["Bindings"]["DATABASES"],
	{ slate, identity }: SlateAccess,
	input: z.infer<typeof databaseQuerySchema>,
) {
	const snapshot = await readSlateDeclarations(artifacts, slate.id)
	if (snapshot.state === "no-commit")
		return { allowed: false, reason: "not-declared" } as const
	const selected = resourcesForConsumer(snapshot.resources, { type: "app" })
	const requirement = selected.databases[input.slug]
	if (!requirement) return { allowed: false, reason: "not-declared" } as const
	const actor = await getSlateActor(db, slate.id, identity.user)
	const resolved = resolveSlateResourceActor(actor, {
		connections: {},
		databases: { [input.slug]: requirement },
		secrets: {},
	})
	if (!resolved.allowed) return resolved
	const database = prepareSlateDatabase(slate, resolved.viewer, input.slug, requirement)
	return {
		allowed: true,
		result: await databases
			.getByName(database.instance_name)
			.query(input.sql, input.params),
	} as const
}
