import { resourcesForConsumer } from "@usecontextlayer/shared/slate"
import type { LocalToolsProps } from "@usecontextlayer/shared/tools-worker"
import { getLocalAppId } from "@/app"
import { getAccessToken } from "@/auth"
import { env } from "@/env"
import { prepareLocalResourceConfiguration } from "@/resources"

export async function getLocalToolsBindings() {
	const configuration = await prepareLocalResourceConfiguration()
	const { connections } = resourcesForConsumer(configuration, { type: "app" })
	return {
		props: {
			appId: await getLocalAppId(),
			connections,
			credential: { token: await getAccessToken(env), type: "access-token" as const },
		} satisfies LocalToolsProps,
		vars: { CTX_PLATFORM_URL: env.CTX_PLATFORM_URL },
	}
}
