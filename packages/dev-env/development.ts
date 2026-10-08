import { resolve } from "node:path"
import { createPolarCore } from "@polar-sh/sdk/2026-10"
import {
	type AuthEnv,
	getAccessToken,
	getCurrentUser,
	listOrganizations,
} from "@usecontextlayer/cli/auth"
import { execaNode } from "execa"
import { z } from "zod"
import { readDopplerEnv } from "@/doppler"
import {
	type DevelopmentEnv,
	readAppOAuthEnv,
	readDevelopmentIdentityEnv,
	readPolarEnv,
} from "@/env"
import { readPolarCatalog, readPolarWebhookSecret } from "@/polar"

export async function readWebDevelopmentEnv(webRoot: string, addresses: DevelopmentEnv) {
	const webEnv = await readDopplerEnv(webRoot, "web", "dev_personal")
	return {
		...webEnv,
		...readDevelopmentIdentityEnv(webEnv),
		BETTER_AUTH_URL: addresses.BETTER_AUTH_URL.href,
		CTX_PLATFORM_URL: addresses.CTX_PLATFORM_URL.href,
		CTX_VIEWER_AUTH_URL: addresses.CTX_VIEWER_AUTH_URL.href,
		DATABASE_URL: addresses.DATABASE_URL,
	}
}

type WebDevelopmentEnv = Awaited<ReturnType<typeof readWebDevelopmentEnv>>

export async function readDevelopmentServiceEnv(
	root: string,
	webEnv: WebDevelopmentEnv,
	addresses: DevelopmentEnv,
) {
	const appOAuthEnv = readAppOAuthEnv(webEnv)
	const platformSecrets = await readDopplerEnv(root, "platform", "dev")
	const polarEnv = readPolarEnv(platformSecrets)
	const polar = createPolarCore({
		accessToken: polarEnv.POLAR_ACCESS_TOKEN,
		environment: polarEnv.POLAR_ENVIRONMENT,
	})
	const catalog = await readPolarCatalog(polar, polarEnv.POLAR_FREE_PRODUCT_ID)
	const issuer = new URL("/api/auth", addresses.BETTER_AUTH_URL).href
	return {
		addresses,
		catalog,
		issuer,
		platformEnv: {
			...platformSecrets,
			...polarEnv,
			...appOAuthEnv,
			CLOUDFLARE_ENV: "test",
			CTX_AUTH_ISSUER: issuer,
			CTX_PLATFORM_DATABASE_URL: addresses.CTX_PLATFORM_DATABASE_URL,
			POLAR_CLIPS_METER_ID: catalog.clipsMeter.id,
			POLAR_FREE_PRODUCT_ID: catalog.freeProduct.id,
			POLAR_WEBHOOK_SECRET: await readPolarWebhookSecret(polarEnv),
		},
		polarEnv,
		webEnv: {
			...webEnv,
			...appOAuthEnv,
			POLAR_ACCESS_TOKEN: polarEnv.POLAR_ACCESS_TOKEN,
			POLAR_ENVIRONMENT: polarEnv.POLAR_ENVIRONMENT,
		},
	}
}

export async function readDevelopmentCommandEnv(
	webRoot: string,
	webEnv: WebDevelopmentEnv,
	addresses: DevelopmentEnv,
) {
	const { ipcOutput } = await execaNode(
		resolve(webRoot, "scripts/development-client.mts"),
		{
			cwd: webRoot,
			env: {
				...webEnv,
				TSX_TSCONFIG_PATH: resolve(webRoot, "tsconfig.tsxrepl.json"),
			},
			ipc: true,
			nodeOptions: ["--import", "tsx"],
			stdio: ["ignore", 2, "inherit"],
		},
	)
	return {
		...Object.fromEntries(
			Object.entries(addresses).map(([key, value]) => [key, value.toString()]),
		),
		CTX_AUTH_CLIENT_ID: z.string().min(1).parse(ipcOutput[0]),
		CTX_AUTH_ISSUER: new URL("/api/auth", webEnv.BETTER_AUTH_URL).href,
	}
}

export async function readDevelopmentIdentity(env: AuthEnv) {
	const headers = { authorization: `Bearer ${await getAccessToken(env)}` }
	const user = await getCurrentUser(env, headers)
	const organizations = await listOrganizations(env, headers)
	return { headers, organizations, user }
}
