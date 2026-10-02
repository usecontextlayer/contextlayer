import { z } from "zod"

export function createArtifactsClient(config: {
	CLOUDFLARE_ACCOUNT_ID: string
	CLOUDFLARE_API_TOKEN: string
	CTX_ARTIFACTS_NAMESPACE: string
}) {
	const base = `https://api.cloudflare.com/client/v4/accounts/${config.CLOUDFLARE_ACCOUNT_ID}/artifacts/namespaces/${encodeURIComponent(config.CTX_ARTIFACTS_NAMESPACE)}`
	return {
		request(path: string, body?: unknown) {
			return fetch(`${base}${path}`, {
				body: body === undefined ? undefined : JSON.stringify(body),
				headers: {
					authorization: `Bearer ${config.CLOUDFLARE_API_TOKEN}`,
					"content-type": "application/json",
				},
				method: body === undefined ? "GET" : "POST",
			})
		},
	}
}

export type ArtifactsClient = ReturnType<typeof createArtifactsClient>

export async function readArtifactsResult<T>(response: Response, schema: z.ZodType<T>) {
	if (!response.ok) throw new Error(`Artifacts API returned HTTP ${response.status}`)
	return z
		.object({ result: schema, success: z.literal(true) })
		.parse(await response.json()).result
}
