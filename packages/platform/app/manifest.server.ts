import { type Slate, slateSchema } from "@usecontextlayer/shared/slate"
import type { App } from "@/apps.schema"

export type ManifestSnapshot = {
	manifest: Slate
	source: "local" | "deployed"
}

export async function getAppManifest(
	app: App,
	apps: DispatchNamespace,
	localManifest?: Slate,
): Promise<ManifestSnapshot> {
	if (localManifest) return { manifest: localManifest, source: "local" }
	const response = await apps
		.get(app.id)
		.fetch(
			new Request(`https://${app.public_hostname}/slate.json`, { redirect: "manual" }),
		)
	if (!response.ok)
		throw new Error(`App manifest request failed: HTTP ${response.status}`)
	return { manifest: slateSchema.parse(await response.json()), source: "deployed" }
}
