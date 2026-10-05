import { isCancel, password } from "@clack/prompts"
import { z } from "zod"
import { getAccessToken, getCurrentUser } from "@/auth"
import { env } from "@/env"

export const secretNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/)
export const secretOptionsSchema = z.object({
	org: z.string().min(1).optional(),
	stdin: z.boolean().default(false),
})
const valueSchema = z.string().min(1)
const confirmationSchema = z.object({
	name: secretNameSchema,
	owner: z.object({ id: z.string().min(1), type: z.enum(["organization", "user"]) }),
})

async function resolveSecretUrl(
	name: string,
	org: string | undefined,
	headers: HeadersInit,
) {
	let type: "org" | "user"
	let id: string
	if (org) {
		const url = new URL("/api/platform/organizations", env.CTX_AUTH_ISSUER)
		const response = await fetch(url, { headers })
		if (!response.ok)
			throw new Error(`Organization lookup failed: HTTP ${response.status}`)
		const { organizations } = z
			.object({
				organizations: z.array(z.object({ id: z.string().min(1), slug: z.string() })),
			})
			.parse(await response.json())
		const organization = organizations.find((organization) => organization.slug === org)
		if (!organization) throw new Error("Organization is not in your memberships")
		type = "org"
		id = organization.id
	} else {
		id = (await getCurrentUser(headers)).id
		type = "user"
	}
	return new URL(
		`/api/secrets/${type}/${encodeURIComponent(id)}/${encodeURIComponent(name)}`,
		env.CTX_PLATFORM_URL,
	)
}

export async function setSecret(
	name: string,
	options: z.output<typeof secretOptionsSchema>,
) {
	const headers = { authorization: `Bearer ${await getAccessToken()}` }
	const url = await resolveSecretUrl(name, options.org, headers)
	let value: string
	if (options.stdin) {
		process.stdin.setEncoding("utf8")
		value = ""
		for await (const chunk of process.stdin) value += chunk
	} else {
		// Do not mistake redirected input for permission to submit it as a secret.
		if (!process.stdin.isTTY)
			throw new Error("Use --stdin to read a secret without a terminal")
		const entered = await password({
			message: `Value for ${name}`,
			output: process.stderr,
			validate: valueSchema,
		})
		if (isCancel(entered)) {
			process.exitCode = 130
			return
		}
		value = entered
	}
	const response = await fetch(url, {
		body: JSON.stringify({ value: valueSchema.parse(value) }),
		headers: { ...headers, "content-type": "application/json" },
		method: "PUT",
	})
	if (!response.ok) throw new Error(`Secret save failed: HTTP ${response.status}`)
	console.log(JSON.stringify(confirmationSchema.parse(await response.json())))
}

export async function dropSecret(name: string, org: string | undefined) {
	const headers = { authorization: `Bearer ${await getAccessToken()}` }
	const response = await fetch(await resolveSecretUrl(name, org, headers), {
		headers,
		method: "DELETE",
	})
	if (!response.ok) throw new Error(`Secret drop failed: HTTP ${response.status}`)
	console.log(JSON.stringify(confirmationSchema.parse(await response.json())))
}
