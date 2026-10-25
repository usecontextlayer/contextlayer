import { SignJWT } from "jose"
import type { BuildBindings } from "@/env"

export async function artifactTransferEnv(
	env: Pick<
		BuildBindings,
		| "CLOUDFLARE_ACCOUNT_ID"
		| "BACKUP_BUCKET_NAME"
		| "R2_ACCESS_KEY_ID"
		| "R2_SECRET_ACCESS_KEY"
	>,
	instanceId: string,
	scope: "object-read-write" | "object-read-only",
) {
	const endpoint = `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`
	const prefix = `build-artifacts/${encodeURIComponent(instanceId)}/`
	const token = await new SignJWT({
		bucket: env.BACKUP_BUCKET_NAME,
		paths: { prefixPaths: [prefix] },
		scope,
	})
		.setProtectedHeader({ alg: "HS256", typ: "JWT" })
		.setSubject(env.CLOUDFLARE_ACCOUNT_ID)
		.setIssuer(env.R2_ACCESS_KEY_ID)
		.setAudience(new URL(endpoint).host)
		.setIssuedAt()
		// The upload grant must outlive build attempts and their retry delays.
		.setExpirationTime("1h")
		.sign(new TextEncoder().encode(env.R2_SECRET_ACCESS_KEY))
	// R2's local-signing protocol derives the temporary secret from the signed JWT.
	// https://developers.cloudflare.com/r2/examples/authenticate-r2-temp-credentials/
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
	return {
		CTX_BUILD_ARTIFACT_PATH: `artifact:${env.BACKUP_BUCKET_NAME}/${prefix}`,
		RCLONE_CONFIG_ARTIFACT_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
		RCLONE_CONFIG_ARTIFACT_ENDPOINT: endpoint,
		RCLONE_CONFIG_ARTIFACT_NO_CHECK_BUCKET: "true",
		RCLONE_CONFIG_ARTIFACT_PROVIDER: "Cloudflare",
		RCLONE_CONFIG_ARTIFACT_REGION: "auto",
		RCLONE_CONFIG_ARTIFACT_SECRET_ACCESS_KEY: Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join(""),
		RCLONE_CONFIG_ARTIFACT_SESSION_TOKEN: btoa(`jwt/${token}`),
		RCLONE_CONFIG_ARTIFACT_TYPE: "s3",
	}
}
