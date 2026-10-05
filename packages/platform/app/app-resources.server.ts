import {
	collectAppResources,
	type Resources,
	type Slate,
} from "@usecontextlayer/shared/slate"
import { readAppDeclarations } from "@/app-declarations.server"
import type { App } from "@/apps.schema"

export type ResourcesSnapshot =
	| { resources: Resources; source: "local" }
	| { commit: string; resources: Resources; source: "repository" }

export async function getAppResources(
	app: App,
	artifacts: Artifacts,
	localManifest?: Slate,
): Promise<ResourcesSnapshot> {
	if (localManifest)
		return {
			resources: collectAppResources({ agents: {}, app: localManifest }),
			source: "local",
		}
	const { commit, resources } = await readAppDeclarations(artifacts, app.id)
	return { commit, resources, source: "repository" }
}
