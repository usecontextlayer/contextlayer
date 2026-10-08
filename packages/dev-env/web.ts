import { createAuthClient } from "better-auth/client"
import { setCookieToHeader } from "better-auth/cookies"

export async function signInWeb({
	baseURL,
	email,
	password,
}: {
	baseURL: string
	email: string
	password: string
}) {
	const headers = new Headers({ origin: new URL(baseURL).origin })
	const client = createAuthClient({
		baseURL,
		fetchOptions: {
			headers,
			onSuccess: setCookieToHeader(headers),
			throw: true,
		},
	})
	const { user } = await client.signIn.email({ email, password })
	return { client, headers, user }
}
