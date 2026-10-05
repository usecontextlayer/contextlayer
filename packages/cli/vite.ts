import { getLocalAppId, readLocalManifest } from "@/app"
import { getAccessToken } from "@/auth"
import { env } from "@/env"

export async function getLocalToolsBindings() {
	return {
		props: {
			appId: await getLocalAppId(),
			credential: { token: await getAccessToken(), type: "access-token" as const },
			manifest: await readLocalManifest(),
		},
		vars: { CTX_PLATFORM_URL: env.CTX_PLATFORM_URL },
	}
}
