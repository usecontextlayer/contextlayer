import { z } from "zod"
import { type Bindings, parseEnv } from "@/env"

const resolvedApp = z.object({ id: z.uuid() })

export default {
	async fetch(request, bindings) {
		const env = parseEnv(bindings)
		const lookup = new URL("/api/apps/resolve", env.CTX_PLATFORM_URL)
		lookup.searchParams.set("hostname", new URL(request.url).hostname)
		const response = await fetch(lookup)
		if (!response.ok) return response
		const { id } = resolvedApp.parse(await response.json())
		return bindings.APPS.get(id).fetch(request)
	},
} satisfies ExportedHandler<Bindings>
