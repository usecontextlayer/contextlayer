import { expect, test } from "vitest"
import { isSecretKey, secretKey } from "@/secrets.server"

test.each(["personal", "organization"] as const)(
	"recognizes saved %s subscription keys without selecting API keys",
	(type) => {
		const owner = { id: "credential-owner", type }
		const subscription = secretKey(owner, "CLAUDE_CODE_OAUTH_TOKEN")
		const api = secretKey(owner, "ANTHROPIC_API_KEY")
		expect(isSecretKey(subscription, "CLAUDE_CODE_OAUTH_TOKEN")).toBe(true)
		expect(isSecretKey(api, "CLAUDE_CODE_OAUTH_TOKEN")).toBe(false)
	},
)
