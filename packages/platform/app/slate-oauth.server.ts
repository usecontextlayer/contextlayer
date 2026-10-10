import type { Slate } from "@/slates.schema"

export async function provisionSlateOAuth(
	slate: Pick<Slate, "id" | "public_hostname">,
	issuer: string,
	provisioningSecret: string,
) {
	const response = await fetch(`${issuer.replace(/\/$/, "")}/app-oauth/provision`, {
		body: JSON.stringify({ id: slate.id, public_hostname: slate.public_hostname }),
		headers: {
			Authorization: `Bearer ${provisioningSecret}`,
			"Content-Type": "application/json",
		},
		method: "POST",
	})
	if (!response.ok) throw new Error(`Slate OAuth provisioning failed: ${response.status}`)
}
