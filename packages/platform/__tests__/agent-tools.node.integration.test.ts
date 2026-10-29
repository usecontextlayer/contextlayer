import { Composio } from "@composio/core"
import { renderToolSignature } from "@earendil-works/pi-codemode"
import { test } from "@tests/integration"
import { accountsSchema } from "@usecontextlayer/shared/accounts"
import { createAgentTools } from "@usecontextlayer/shared/agent-tools"
import { toolResultSchema } from "@usecontextlayer/shared/tools"
import { expect } from "vitest"
import { z } from "zod"
import { createAccountSession } from "@/accounts.server"

test("agent tools bind two Gmail namespaces to their connected accounts", async ({
	platform,
	webSession,
}) => {
	const { origin, worker } = platform
	const headers = new Headers(webSession.headers)
	headers.set("origin", origin)
	const accountsResponse = await fetch(`${origin}/api/accounts?toolkit=gmail`, {
		headers,
	})
	expect(accountsResponse.status).toBe(200)
	const { accounts } = accountsSchema.parse(await accountsResponse.json())
	// Distinct identities make a namespace routed to the wrong account observable.
	const first = accounts[0]
	const second = accounts.find((account) => account.display_name !== first?.display_name)
	if (!first || !second)
		throw new Error("Connect two distinct Gmail accounts to the DevEnv user")
	const assignments = { personal_email: second, work_email: first }
	for (const account of Object.values(assignments)) z.email().parse(account.display_name)
	const { COMPOSIO_API_KEY } = await worker.getEnv()
	const composio = new Composio({ apiKey: COMPOSIO_API_KEY })
	const { extension } = createAgentTools(
		await Promise.all(
			Object.entries(assignments).map(async ([name, account]) => {
				const session = await createAccountSession(
					COMPOSIO_API_KEY,
					{ id: webSession.user.id, type: "personal" },
					account.id,
					"gmail",
				)
				return {
					actions: await composio.tools.getRawToolRouterSessionTools(session.sessionId),
					execute: (tool: string, args: Record<string, unknown>) =>
						session.execute(tool, args),
					name,
					toolkit: "gmail",
				}
			}),
		),
	)
	for (const [slug, account] of Object.entries(assignments)) {
		const tool = extension.tools.find(({ name }) => name === `${slug}__GMAIL_GET_PROFILE`)
		if (!tool) throw new Error(`Missing ${slug} profile tool`)
		const declaration = renderToolSignature({
			inputSchema: z.record(z.string(), z.unknown()).parse(tool.parameters),
			name: tool.name,
			outputSchema: z.record(z.string(), z.unknown()).parse(tool.structuredOutputSchema),
		})
		for (const field of ["user_id", "emailAddress", "logId"]) {
			expect(declaration).toContain(field)
		}
		const result = await tool.execute({ user_id: "me" })
		expect(result.isError).toBe(false)
		const profile = toolResultSchema.parse(result.structuredOutput)
		expect(profile.error).toBeNull()
		expect(profile.data.emailAddress).toBe(account.display_name)
		expect(profile.logId.length).toBeGreaterThan(0)
	}
})
