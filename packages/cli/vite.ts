import { getLocalAppId } from "@/app"
import { getAccessToken } from "@/auth"
import { env } from "@/env"

export async function getLocalToolsBindings() {
	return {
		CTX_ACCESS_TOKEN: await getAccessToken(),
		CTX_APP_ID: await getLocalAppId(),
		CTX_PLATFORM_URL: env.CTX_PLATFORM_URL,
	}
}
