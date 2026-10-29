import assert from "node:assert/strict"
import type { Provider } from "@earendil-works/pi-ai/models"
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic"
import type { AgentResources } from "@/lib/agent-resources"
import type { AgentRun } from "@/lib/agents"

export function createAgentProvider(
	resources: () => Pick<
		Fetcher<AgentResources>,
		"loadSecret" | "subscriptionProfile" | "fetch"
	>,
	secrets: () => AgentRun["secrets"],
	jobId: string,
): Provider<"anthropic-messages"> {
	const provider = anthropicProvider()
	const subscriptionFetch: typeof fetch = (input, init) => resources().fetch(input, init)
	const transport = () =>
		Object.hasOwn(secrets(), "ANTHROPIC_API_KEY") ? undefined : subscriptionFetch
	return {
		...provider,
		auth: {
			apiKey: {
				name: "Declared Anthropic access",
				async resolve() {
					const declared = secrets()
					if (Object.hasOwn(declared, "ANTHROPIC_API_KEY")) {
						return {
							auth: {
								apiKey: await resources().loadSecret("ANTHROPIC_API_KEY"),
							},
							source: "ANTHROPIC_API_KEY",
						}
					}
					assert(
						Object.hasOwn(declared, "CLAUDE_CODE_OAUTH_TOKEN"),
						"Declare ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN",
					)
					return {
						auth: {
							apiKey: "meridian",
							baseUrl: "http://meridian",
							headers: {
								"x-meridian-agent": "pi",
								"x-meridian-profile": await resources().subscriptionProfile(),
								"x-session-affinity": jobId,
							},
						},
						source: "CLAUDE_CODE_OAUTH_TOKEN",
					}
				},
			},
		},
		stream: (model, context, options) =>
			provider.stream<"anthropic-messages">(model, context, {
				...options,
				fetch: transport(),
			}),
		streamSimple: (model, context, options) =>
			provider.streamSimple(model, context, { ...options, fetch: transport() }),
	}
}
