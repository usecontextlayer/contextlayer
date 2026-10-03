import { createRemoteJWKSet, jwtVerify } from "jose"
import { z } from "zod"

export const userSchema = z.object({ id: z.string().min(1) })
const claimsSchema = z.object({ scope: z.string(), sub: z.string().min(1) })
const sessionSchema = z.object({ user: userSchema }).nullable()

export async function authenticateAccessToken(token: string, issuer: string) {
	const keys = createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, "")}/jwks`))
	const { payload } = await jwtVerify(token, keys, {
		audience: "urn:ctx:platform",
		issuer,
		requiredClaims: ["sub", "exp", "scope"],
	})
	const claims = claimsSchema.parse(payload)
	return claims.scope.split(" ").includes("ctx:access") ? { id: claims.sub } : null
}

export async function authenticateSession(token: string, issuer: string) {
	const response = await fetch(`${issuer.replace(/\/$/, "")}/get-session`, {
		headers: { Authorization: `Bearer ${token}` },
	})
	if (!response.ok) throw new Error(`Session lookup failed: ${response.status}`)
	return sessionSchema.parse(await response.json())?.user ?? null
}
