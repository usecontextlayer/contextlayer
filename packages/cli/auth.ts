import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import * as oauth from "openid-client"
import { z } from "zod"
import { env } from "@/env"

const authDirectory = join(homedir(), ".contextlayer")
const authPath = join(authDirectory, "auth.json")
const credentialSchema = z.object({
	accessToken: z.string(),
	clientId: z.string(),
	expiresAt: z.number(),
	issuer: z.url(),
	refreshToken: z.string().optional(),
})

export class LoginRequiredError extends Error {
	constructor(reason: string, options?: ErrorOptions) {
		super(`${reason} Run npx @usecontextlayer/cli login.`, options)
	}
}

async function configuration() {
	const issuer = new URL(env.CTX_AUTH_ISSUER)
	return oauth.discovery(issuer, env.CTX_AUTH_CLIENT_ID, undefined, oauth.None(), {
		algorithm: "oauth2",
		execute:
			issuer.protocol === "http:" && ["localhost", "127.0.0.1"].includes(issuer.hostname)
				? [oauth.allowInsecureRequests]
				: [],
	})
}

async function save(tokens: oauth.TokenEndpointResponse, previousRefreshToken?: string) {
	const credentials = credentialSchema.parse({
		accessToken: tokens.access_token,
		clientId: env.CTX_AUTH_CLIENT_ID,
		expiresAt: Date.now() + z.number().parse(tokens.expires_in) * 1000,
		issuer: env.CTX_AUTH_ISSUER,
		refreshToken: tokens.refresh_token ?? previousRefreshToken,
	})
	await mkdir(authDirectory, { mode: 0o700, recursive: true })
	await writeFile(authPath, JSON.stringify(credentials), { mode: 0o600 })
	return credentials
}

export async function login() {
	const config = await configuration()
	const authorization = await oauth.initiateDeviceAuthorization(config, {
		resource: "urn:ctx:platform",
		scope: "offline_access ctx:access",
	})
	console.log(
		`Open ${authorization.verification_uri_complete ?? authorization.verification_uri}`,
	)
	console.log(`Confirm this code: ${authorization.user_code}`)
	console.log("Waiting for approval…")
	const tokens = await oauth.pollDeviceAuthorizationGrant(config, authorization)
	await save(tokens)
	console.log("Signed in to ContextLayer.")
}

export async function getAccessToken() {
	const contents = await readFile(authPath, "utf8").catch((error: unknown) => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			throw new LoginRequiredError("Not signed in.", { cause: error })
		}
		throw error
	})
	let credentials = credentialSchema.parse(JSON.parse(contents))
	if (
		credentials.issuer !== env.CTX_AUTH_ISSUER ||
		credentials.clientId !== env.CTX_AUTH_CLIENT_ID
	) {
		throw new LoginRequiredError(
			"Saved login belongs to a different auth server or client.",
		)
	}
	if (credentials.expiresAt <= Date.now()) {
		if (!credentials.refreshToken) throw new LoginRequiredError("Login expired.")
		credentials = await save(
			await oauth
				.refreshTokenGrant(await configuration(), credentials.refreshToken)
				.catch((error: unknown) => {
					if (error instanceof oauth.ResponseBodyError && error.error === "invalid_grant") {
						throw new LoginRequiredError("Login expired.", { cause: error })
					}
					throw error
				}),
			credentials.refreshToken,
		)
	}
	return credentials.accessToken
}

export async function getCurrentUser(headers: HeadersInit) {
	const response = await fetch(new URL("/api/me", env.CTX_AUTH_ISSUER), { headers })
	if (response.status === 401) throw new LoginRequiredError("Saved login was rejected.")
	if (!response.ok) throw new Error(`Identity request failed: HTTP ${response.status}`)
	return z.object({ id: z.string().min(1) }).parse(await response.json())
}
