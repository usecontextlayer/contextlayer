import type { databaseQuerySchema } from "@usecontextlayer/shared/databases"
import { resourcesForConsumer } from "@usecontextlayer/shared/declaration"
import type { z } from "zod"
import type { PlatformEnv } from "@/context"
import type { PlatformDb } from "@/database"
import type { PlatformConfig } from "@/env"
import { readSlateDeclarations } from "@/slate-declarations.server"
import type { ResolvedSlateResourceConfiguration } from "@/slate-resource-configuration.server"
import { prepareSlateResourceExecution } from "@/slate-resource-execution.server"
import type { SlateAccess } from "@/slates.server"

export async function querySlateDatabase(
	db: PlatformDb,
	artifacts: Artifacts,
	databases: PlatformEnv["Bindings"]["DATABASES"],
	agents: PlatformEnv["Bindings"]["AGENTS"],
	config: PlatformConfig,
	{ slate, identity }: SlateAccess,
	input: z.infer<typeof databaseQuerySchema>,
) {
	const snapshot = await readSlateDeclarations(artifacts, slate.id)
	if (!snapshot.allowed) return { allowed: false, reason: "not-declared" } as const
	const selected = resourcesForConsumer(snapshot.resources, { type: "app" })
	const requirement = selected.databases[input.slug]
	if (!requirement) return { allowed: false, reason: "not-declared" } as const
	const resolved = await prepareSlateResourceExecution(
		db,
		artifacts,
		databases,
		agents,
		config,
		slate,
		{ id: identity.user.id, type: "user" },
		snapshot,
		{
			connections: {},
			databases: { [input.slug]: requirement },
			secrets: {},
		},
	)
	if (!resolved.allowed) return resolved
	const database = resolved.configuration.databases[
		input.slug
	] as ResolvedSlateResourceConfiguration["databases"][string]
	return {
		allowed: true,
		result: await databases
			.getByName(database.instance_name)
			.query(input.sql, input.params),
	} as const
}
