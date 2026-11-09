import assert from "node:assert/strict"
import { renderToolSignature } from "@earendil-works/pi-codemode"
import { test } from "@tests/integration"
import { expect } from "vitest"
import { z } from "zod"
import { createAccountSession, listPersonalAccounts } from "@/accounts.server"
import { createAgentTools } from "@/agent-tools"
import { authenticateSession, hasManagementAuthority } from "@/auth.server"
import { parsePlatformEnv } from "@/env"

test("agent tools expose native action inputs and session result schemas to Code Mode", async ({
	serviceEnv,
	webSession,
}) => {
	const config = parsePlatformEnv(serviceEnv.platformEnv)
	const identity = await authenticateSession(
		{ cookie: z.string().parse(webSession.headers.get("cookie")), type: "cookie" },
		config.CTX_AUTH_ISSUER,
	)
	assert(
		identity && hasManagementAuthority(identity),
		"DevEnv web session must grant management authority",
	)
	const { accounts } = await listPersonalAccounts(config, identity, "gmail")
	const account = accounts[0]
	if (!account) throw new Error("Connect a Gmail account to the DevEnv user")
	const { COMPOSIO_API_KEY } = config
	const session = await createAccountSession(
		COMPOSIO_API_KEY,
		{ id: identity.user.id, type: "personal" },
		account.id,
		"gmail",
	)
	const { tools } = await createAgentTools(COMPOSIO_API_KEY, [
		{ name: "mail", session, toolkit: "gmail" },
	])
	const tool = tools.find(({ name }) => name === "mail__GMAIL_GET_PROFILE")
	if (!tool) throw new Error("Missing mail profile tool")
	const declaration = renderToolSignature({
		inputSchema: z.record(z.string(), z.unknown()).parse(tool.parameters),
		name: tool.name,
		outputSchema: z.record(z.string(), z.unknown()).parse(tool.structuredOutputSchema),
	})
	for (const field of ["user_id", "emailAddress", "logId", "resultType"]) {
		expect(declaration).toContain(field)
	}
})
