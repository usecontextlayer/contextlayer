import { test } from "@tests/integration"
import { runCliWithEnv } from "@tests/secrets"
import { expect } from "vitest"

test("non-writing: CLI requires explicit stdin input and resolves organization membership", async ({
	commandEnv,
}) => {
	const nonTerminal = await runCliWithEnv(commandEnv, [
		"secrets",
		"set",
		"CTX_SECRET_ACCESS_TEST",
	])
	expect(nonTerminal.exitCode).toBe(1)
	expect(nonTerminal.all).toContain("Use --stdin")
	const unknownOrg = await runCliWithEnv(commandEnv, [
		"secrets",
		"--org",
		"not-a-member",
		"drop",
		"CTX_SECRET_ACCESS_TEST",
	])
	expect(unknownOrg.exitCode).toBe(1)
	expect(unknownOrg.all).toContain("Organization is not in your memberships")
})
