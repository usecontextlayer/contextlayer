import { type Slate, slateSchema } from "@usecontextlayer/shared/slate"
import type { AppAccess } from "@/apps.server"
import { credentialHeaders } from "@/auth.server"

export async function getAppManifest(
	{ app, identity }: AppAccess,
	localManifest?: Slate,
) {
	if (localManifest) return localManifest
	const response = await fetch(`https://${app.public_hostname}/slate.json`, {
		headers: credentialHeaders(identity.credential),
	})
	if (!response.ok)
		throw new Error(`App manifest request failed: HTTP ${response.status}`)
	return slateSchema.parse(await response.json())
}
