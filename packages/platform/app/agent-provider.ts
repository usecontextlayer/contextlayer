import assert from "node:assert/strict"
import type { StreamOptions } from "@earendil-works/pi-ai"
import type { Provider } from "@earendil-works/pi-ai/models"
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic"
import type { AgentConfiguration } from "@/agents.schema"
import type { PlatformEnv } from "@/context"
import type { PlatformBindings } from "@/env"
import { loadSharedSecret, secretKey, secretKeyRef } from "@/secrets.server"

export function createAgentProvider(
	config: PlatformBindings,
	meridian: PlatformEnv["Bindings"]["MERIDIAN"],
	secrets: () => AgentConfiguration["secrets"],
): Provider<"anthropic-messages"> {
	const provider = anthropicProvider()
	const subscriptionFetch: typeof fetch = (input, init) =>
		meridian.getByName("shared").fetch(new Request(input, init))
	const transport = <Options extends StreamOptions>(options: Options | undefined) => {
		if (!options?.headers?.["x-meridian-profile"]) return options
		assert(options.sessionId, "Pi must supply the conversation's provider session ID")
		return {
			...options,
			fetch: subscriptionFetch,
			headers: { ...options.headers, "x-session-affinity": options.sessionId },
		}
	}
	return {
		...provider,
		auth: {
			apiKey: {
				name: "Declared Anthropic access",
				async resolve() {
					const declared = secrets()
					if (declared.ANTHROPIC_API_KEY) {
						return {
							auth: {
								apiKey: await loadSharedSecret(
									config,
									declared.ANTHROPIC_API_KEY,
									"ANTHROPIC_API_KEY",
								),
							},
							source: "ANTHROPIC_API_KEY",
						}
					}
					const owner = declared.CLAUDE_CODE_OAUTH_TOKEN
					assert(owner, "Declare ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN")
					return {
						auth: {
							apiKey: "meridian",
							baseUrl: "http://meridian",
							headers: {
								"x-meridian-agent": "pi",
								"x-meridian-profile": secretKeyRef(
									secretKey(owner, "CLAUDE_CODE_OAUTH_TOKEN"),
								),
							},
						},
						source: "CLAUDE_CODE_OAUTH_TOKEN",
					}
				},
			},
		},
		stream: (model, context, options) =>
			provider.stream<"anthropic-messages">(model, context, transport(options)),
		streamSimple: (model, context, options) =>
			provider.streamSimple(model, context, transport(options)),
	}
}
