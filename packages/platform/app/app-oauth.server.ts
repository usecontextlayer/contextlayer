import type { App } from "@/apps.schema"

export async function provisionAppOAuth(
	app: Pick<App, "id" | "public_hostname">,
	issuer: string,
	provisioningSecret: string,
) {
	const response = await fetch(`${issuer.replace(/\/$/, "")}/app-oauth/provision`, {
		body: JSON.stringify({ id: app.id, public_hostname: app.public_hostname }),
		headers: {
			Authorization: `Bearer ${provisioningSecret}`,
			"Content-Type": "application/json",
		},
		method: "POST",
	})
	if (!response.ok) throw new Error(`App OAuth provisioning failed: ${response.status}`)
}
