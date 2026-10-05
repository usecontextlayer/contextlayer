import { WorkerEntrypoint } from "cloudflare:workers"
import { appConnectionsSchema } from "@usecontextlayer/shared/app-connections"
import { type Bindings, parseEnv } from "@/env"

interface ConnectionsProps {
	appId: string
	sessionToken: string
}

export class Connections extends WorkerEntrypoint<Bindings, ConnectionsProps> {
	async list() {
		const { appId, sessionToken } = this.ctx.props
		const env = parseEnv(this.env)
		const response = await fetch(
			new URL(`/api/apps/${appId}/connections/list`, env.CTX_PLATFORM_URL),
			{
				body: JSON.stringify({}),
				headers: {
					"content-type": "application/json",
					cookie: `__Secure-ctx_viewer=${encodeURIComponent(sessionToken)}`,
				},
				method: "POST",
			},
		)
		if (!response.ok)
			throw new Error(`App connections request failed: HTTP ${response.status}`)
		return appConnectionsSchema.parse(await response.json()).connections
	}
}
