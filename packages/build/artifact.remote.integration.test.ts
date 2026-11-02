import assert from "node:assert/strict"
import { AwsClient } from "aws4fetch"
import { expect, test } from "vitest"
import { unstable_readConfig as readConfig } from "wrangler"
import { artifactTransferEnv } from "@/artifact"

test("R2 confines build credentials to their Workflow artifact prefix", async () => {
	const { vars } = readConfig({ config: "wrangler.jsonc", env: "test" })
	const { CLOUDFLARE_ACCOUNT_ID, BACKUP_BUCKET_NAME } = vars
	const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env
	assert(typeof CLOUDFLARE_ACCOUNT_ID === "string")
	assert(typeof BACKUP_BUCKET_NAME === "string")
	assert(R2_ACCESS_KEY_ID, "R2_ACCESS_KEY_ID is required")
	assert(R2_SECRET_ACCESS_KEY, "R2_SECRET_ACCESS_KEY is required")
	const id = crypto.randomUUID()
	const env = {
		BACKUP_BUCKET_NAME,
		CLOUDFLARE_ACCOUNT_ID,
		R2_ACCESS_KEY_ID,
		R2_SECRET_ACCESS_KEY,
	}
	const transfer = await artifactTransferEnv(env, id, "object-read-write")
	const otherTransfer = await artifactTransferEnv(
		env,
		crypto.randomUUID(),
		"object-read-write",
	)
	const author = new AwsClient({
		accessKeyId: transfer.RCLONE_CONFIG_ARTIFACT_ACCESS_KEY_ID,
		region: "auto",
		secretAccessKey: transfer.RCLONE_CONFIG_ARTIFACT_SECRET_ACCESS_KEY,
		service: "s3",
		sessionToken: transfer.RCLONE_CONFIG_ARTIFACT_SESSION_TOKEN,
	})
	const parent = new AwsClient({
		accessKeyId: R2_ACCESS_KEY_ID,
		region: "auto",
		secretAccessKey: R2_SECRET_ACCESS_KEY,
		service: "s3",
	})
	const allowed = new URL(
		`${new URL(transfer.CTX_BUILD_ARTIFACT_PATH).pathname}probe.txt`,
		transfer.RCLONE_CONFIG_ARTIFACT_ENDPOINT,
	).href
	const outside = new URL(
		`${new URL(otherTransfer.CTX_BUILD_ARTIFACT_PATH).pathname}probe.txt`,
		otherTransfer.RCLONE_CONFIG_ARTIFACT_ENDPOINT,
	).href
	await using resources = new AsyncDisposableStack()
	for (const url of [allowed, outside]) {
		resources.defer(async () => {
			const response = await parent.fetch(url, { method: "DELETE" })
			expect(response.status).toBe(204)
		})
	}

	const uploaded = await author.fetch(allowed, { body: id, method: "PUT" })
	expect(uploaded.status).toBe(200)
	const downloaded = await author.fetch(allowed)
	expect(downloaded.status).toBe(200)
	expect(await downloaded.text()).toBe(id)
	const denied = await author.fetch(outside, { body: id, method: "PUT" })
	expect(denied.status).toBe(403)
	expect(await denied.text()).toContain("<Code>AccessDenied</Code>")
}, 30_000)
