import { isCancel, password } from "@clack/prompts"
import { ownerSchema } from "@usecontextlayer/shared/app-usage"
import { secretNameSchema } from "@usecontextlayer/shared/slate"
import { z } from "zod"
import { getAccessToken } from "@/auth"
import { env } from "@/env"
import { ownerOptionsSchema, ownerPath, resolveOwner } from "@/owner"

export { secretNameSchema }
export const secretOptionsSchema = ownerOptionsSchema.extend({
	stdin: z.boolean().default(false),
})
const valueSchema = z.string().min(1)
const confirmationSchema = z.object({
	name: secretNameSchema,
	owner: ownerSchema,
})

async function resolveSecretUrl(
	name: string,
	org: string | undefined,
	headers: HeadersInit,
) {
	const owner = await resolveOwner(org, headers)
	return new URL(
		`/api/secrets/${ownerPath(owner)}/${encodeURIComponent(name)}`,
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
