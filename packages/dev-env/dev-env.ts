import { resolve } from "node:path"
import {
	type AuthEnv,
	getAccessToken,
	getCurrentUser,
	listOrganizations,
} from "@usecontextlayer/cli/auth"
import { readDopplerEnv } from "@/doppler"
import {
	type DevEnv,
	type DevEnvPorts,
	readDevEnvIdentityEnv,
	readPolarEnv,
	readSlateOAuthEnv,
} from "@/env"

export async function readDevEnvWebEnv(webRoot: string, addresses: DevEnv) {
	const webEnv = await readDopplerEnv(webRoot, "web", "dev_personal")
	return {
		...webEnv,
		...readDevEnvIdentityEnv(webEnv),
		BETTER_AUTH_URL: addresses.BETTER_AUTH_URL.href,
		CTX_PLATFORM_URL: addresses.CTX_PLATFORM_URL.href,
		CTX_VIEWER_AUTH_URL: addresses.CTX_VIEWER_AUTH_URL.href,
		DATABASE_URL: addresses.DATABASE_URL,
	}
}

type DevEnvWebEnv = Awaited<ReturnType<typeof readDevEnvWebEnv>>

export async function readDevEnvServiceEnv(
	root: string,
	webEnv: DevEnvWebEnv,
	addresses: DevEnv,
) {
	const slateOAuthEnv = readSlateOAuthEnv(webEnv)
	const platformSecrets = await readDopplerEnv(root, "platform", "dev")
	const polarEnv = readPolarEnv(platformSecrets)
	const issuer = new URL("/api/auth", addresses.BETTER_AUTH_URL).href
	return {
		addresses,
		issuer,
		platformEnv: {
			...platformSecrets,
			...polarEnv,
			...slateOAuthEnv,
			CLOUDFLARE_ENV: "test",
			CTX_AUTH_ISSUER: issuer,
			CTX_PLATFORM_DATABASE_URL: addresses.CTX_PLATFORM_DATABASE_URL,
		},
		polarEnv,
		webEnv: {
			...webEnv,
			...slateOAuthEnv,
			POLAR_ACCESS_TOKEN: polarEnv.POLAR_ACCESS_TOKEN,
			POLAR_ENVIRONMENT: polarEnv.POLAR_ENVIRONMENT,
		},
	}
}

export function readDevEnvCommandEnv(root: string, addresses: DevEnv & DevEnvPorts) {
	return {
		...Object.fromEntries(
			Object.entries(addresses).map(([key, value]) => [key, value.toString()]),
		),
		CTX_AUTH_CLIENT_ID: addresses.CTX_AUTH_CLIENT_ID,
		CTX_AUTH_ISSUER: new URL("/api/auth", addresses.BETTER_AUTH_URL).href,
		CTX_CLI_COMMAND: `pnpm --silent -C '${resolve(root).replaceAll("'", "'\\''")}' dev:ctx`,
		CTX_CONFIG_DIR: resolve(root, ".contextlayer/cli"),
	}
}

export async function readDevEnvIdentity(env: AuthEnv) {
	const headers = { authorization: `Bearer ${await getAccessToken(env)}` }
	const user = await getCurrentUser(env, headers)
	const organizations = await listOrganizations(env, headers)
	return { headers, organizations, user }
}
