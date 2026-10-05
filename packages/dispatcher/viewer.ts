import { WorkerEntrypoint } from "cloudflare:workers"
import { z } from "zod"
import { type Bindings, parseEnv } from "@/env"

const userSchema = z.object({
	id: z.string().min(1),
	image: z.string().nullable(),
	name: z.string(),
})

interface ViewerProps {
	sessionToken: string
}

export class Viewer extends WorkerEntrypoint<Bindings, ViewerProps> {
	async getCurrentUser() {
		const { sessionToken } = this.ctx.props
		const env = parseEnv(this.env)
		const response = await fetch(new URL("/api/me", env.CTX_AUTH_ISSUER), {
			headers: { cookie: `ctx-viewer-auth=${encodeURIComponent(sessionToken)}` },
		})
		if (response.status === 401) return null
		if (!response.ok) throw new Error(`Identity request failed: HTTP ${response.status}`)
		return userSchema.parse(await response.json())
	}
}
