import { createRemoteJWKSet, jwtVerify } from "jose"
import { z } from "zod"

export const userSchema = z.object({ id: z.string().min(1) })
const claimsSchema = z.object({ scope: z.string(), sub: z.string().min(1) })

export async function authenticate(token: string, issuer: string) {
	const keys = createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, "")}/jwks`))
	const { payload } = await jwtVerify(token, keys, {
		audience: "urn:ctx:platform",
		issuer,
		requiredClaims: ["sub", "exp", "scope"],
	})
	const claims = claimsSchema.parse(payload)
	return claims.scope.split(" ").includes("ctx:access") ? { id: claims.sub } : null
}
