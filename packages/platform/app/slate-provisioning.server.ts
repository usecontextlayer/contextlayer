import type {
	AgentActor,
	SlateDeclarationSnapshot,
	SlateProvisioning,
} from "@usecontextlayer/shared/slate-provisioning"
import { getSlateOwner } from "@/owner"
import { prepareSlateDatabaseConfiguration } from "@/slate-resource-configuration.server"
import type { Slate } from "@/slates.schema"

export function prepareSlateProvisioning(
	slate: Slate,
	actors: AgentActor[],
	snapshot: SlateDeclarationSnapshot,
): SlateProvisioning {
	const instances = new Map<string, SlateProvisioning["databases"][number]>()
	for (const actor of actors) {
		const configuration = prepareSlateDatabaseConfiguration(
			slate,
			actor.type === "user" ? actor : null,
			Object.fromEntries(
				Object.entries(snapshot.resources.databases).filter(
					([, requirement]) =>
						requirement.mode === (actor.type === "app" ? "owner" : "viewer"),
				),
			),
		)
		for (const [slug, { instance_name, owner }] of Object.entries(configuration))
			instances.set(instance_name, { instance_name, owner, slug })
	}
	return {
		actors,
		databases: [...instances.values()],
		slate: { id: slate.id, owner: getSlateOwner(slate) },
		snapshot,
	}
}
