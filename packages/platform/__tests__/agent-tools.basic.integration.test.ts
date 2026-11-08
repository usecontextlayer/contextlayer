import assert from "node:assert/strict"
import { renderToolSignature } from "@earendil-works/pi-codemode"
import { test } from "@tests/integration"
import { toolResultSchema } from "@usecontextlayer/shared/tools"
import { expect } from "vitest"
import { z } from "zod"
import { createAccountSession, listPersonalAccounts } from "@/accounts.server"
import { createAgentTools } from "@/agent-tools"
import { authenticateSession } from "@/auth.server"
import { parsePlatformEnv } from "@/env"

test("agent tools bind two Gmail namespaces to their connected accounts", async ({
	serviceEnv,
	webSession,
}) => {
	const config = parsePlatformEnv(serviceEnv.platformEnv)
	const identity = await authenticateSession(
		{ cookie: z.string().parse(webSession.headers.get("cookie")), type: "cookie" },
		config.CTX_AUTH_ISSUER,
	)
	assert(identity?.type === "owner", "DevEnv web session must authenticate as an Owner")
	const { accounts } = await listPersonalAccounts(config, identity, "gmail")
	// Distinct identities make a namespace routed to the wrong account observable.
	const first = accounts[0]
	const second = accounts.find((account) => account.display_name !== first?.display_name)
	if (!first || !second)
		throw new Error("Connect two distinct Gmail accounts to the DevEnv user")
	const assignments = { personal_email: second, work_email: first }
	for (const account of Object.values(assignments)) z.email().parse(account.display_name)
	const { COMPOSIO_API_KEY } = config
	const connections = await Promise.all(
		Object.entries(assignments).map(async ([name, account]) => ({
			name,
			session: await createAccountSession(
				COMPOSIO_API_KEY,
				{ id: identity.user.id, type: "personal" },
				account.id,
				"gmail",
			),
			toolkit: "gmail",
		})),
	)
	const { extension } = await createAgentTools(
		COMPOSIO_API_KEY,
		connections,
		async (name) => {
			const connection = connections.find((connection) => connection.name === name)
			assert(connection)
			return connection.session
		},
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
