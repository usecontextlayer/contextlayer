import type { databaseQuerySchema } from "@usecontextlayer/shared/databases"
import { resourcesForConsumer } from "@usecontextlayer/shared/slate"
import type { z } from "zod"
import { readAppDeclarations } from "@/app-declarations.server"
import { prepareAppDatabaseConfiguration } from "@/app-resources.server"
import type { AppAccess } from "@/apps.server"
import type { PlatformEnv } from "@/context"

export async function queryAppDatabase(
	artifacts: Artifacts,
	databases: PlatformEnv["Bindings"]["DATABASES"],
	{ app, identity }: AppAccess,
	input: z.infer<typeof databaseQuerySchema>,
) {
	const snapshot = await readAppDeclarations(artifacts, app.id)
	if (snapshot.state === "no-commit") return { allowed: false } as const
	const selected = resourcesForConsumer(snapshot.resources, { type: "app" })
	const configuration = prepareAppDatabaseConfiguration(
		app,
		identity.user,
		selected.databases,
	)
	const database = configuration[input.slug]
	if (!database) return { allowed: false } as const
	return {
		allowed: true,
		result: await databases
			.getByName(database.instance_name)
			.query(input.sql, input.params),
	} as const
}
