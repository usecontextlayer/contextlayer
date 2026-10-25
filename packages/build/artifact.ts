import { AwsClient } from "aws4fetch"
import type { BuildBindings } from "@/env"

export async function signArtifactUrl(
	env: Pick<
		BuildBindings,
		| "CLOUDFLARE_ACCOUNT_ID"
		| "BACKUP_BUCKET_NAME"
		| "R2_ACCESS_KEY_ID"
		| "R2_SECRET_ACCESS_KEY"
	>,
	instanceId: string,
	method: "GET" | "PUT",
): Promise<string> {
	const url = new URL(
		`https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.BACKUP_BUCKET_NAME}/build-artifacts/${encodeURIComponent(instanceId)}.tar.gz`,
	)
	// The upload URL must outlive build attempts and their retry delays.
	url.searchParams.set("X-Amz-Expires", "3600")
	const signer = new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		region: "auto",
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		service: "s3",
	})
	return (await signer.sign(url, { aws: { signQuery: true }, method })).url
}
