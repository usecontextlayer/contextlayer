import { accountsSchema } from "@usecontextlayer/shared/accounts"
import { z } from "zod"
import { getAccessToken } from "@/auth"
import { env } from "@/env"
import { ownerPath, resolveOwner } from "@/owner"

export async function connectAccount(toolkit: string, org: string | undefined) {
	const headers = { authorization: `Bearer ${await getAccessToken(env)}` }
	const owner = await resolveOwner(org, headers)
	const response = await fetch(
		new URL(`/api/accounts/${ownerPath(owner)}`, env.CTX_PLATFORM_URL),
		{
			body: JSON.stringify({ toolkit }),
			headers: {
				...headers,
				"content-type": "application/json",
			},
			method: "POST",
		},
	)
	if (!response.ok) throw new Error(`Connecting account failed: HTTP ${response.status}`)
	const { redirect_url } = z
		.object({ redirect_url: z.url() })
		.parse(await response.json())
	console.log(`Open this link to connect the Owner's account:\n${redirect_url}`)
	console.log(
		"After connecting in your browser, assign the connected account to a slate's declared connection.",
	)
	if (!org) {
		console.log(
			"From your checkout, assign your connected account to a connection declared in slate.json:\n  npx @usecontextlayer/cli connections local assign <slug>",
		)
	}
	console.log(
		`For a hosted slate, get the connected account ID and assign it:\n  npx @usecontextlayer/cli accounts${org ? ` --org '${org.replaceAll("'", "'\\''")}'` : ""} list\n  npx @usecontextlayer/cli connections <SlateID-or-hostname> assign <slug> <account_id>`,
	)
}

export async function listAccounts(org: string | undefined) {
	const headers = { authorization: `Bearer ${await getAccessToken(env)}` }
	const owner = await resolveOwner(org, headers)
	const response = await fetch(
		new URL(`/api/accounts/${ownerPath(owner)}`, env.CTX_PLATFORM_URL),
		{
			headers,
		},
	)
	if (!response.ok)
		throw new Error(`Connected account list failed: HTTP ${response.status}`)
	const { accounts } = accountsSchema.parse(await response.json())
	if (accounts.length === 0) {
		console.log("No connected accounts.")
		return
	}
	console.table(accounts)
}
