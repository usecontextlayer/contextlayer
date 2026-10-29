import assert from "node:assert/strict"
import { test } from "@tests/slate-secret-setup"
import { expect } from "vitest"
import { parseSharedSecretsEnv } from "@/env"
import { listSharedSecretNames, loadSharedSecret, secretKey } from "@/secrets.server"

// These are real vault writes. An interrupted process can leave keys despite the cleanup below.
test("live Doppler: API partial save and chrome final save provision agent-only personal schedules", {
	timeout: 180_000,
}, async ({ platform, provisioning, secretSlate, webSession }) => {
	const { chromeHeaders, chromeUrl, headers, instance, members, names, slate } =
		secretSlate
	const owner = { id: webSession.user.id, type: "personal" } as const
	const vault = parseSharedSecretsEnv(platform.env)
	const secretNames = await listSharedSecretNames(platform.env)
	for (const name of names) expect(secretNames.has(secretKey(owner, name))).toBe(false)
	await using cleanup = new AsyncDisposableStack()
	const values = [
		"synthetic-slate-primary-value",
		"synthetic-slate-secondary-value",
	] as const
	await using workflows =
		await provisioning.worker.introspectWorkflow("MEMBER_PROVISIONING")
	for (const [index, name] of names.entries()) {
		const value = values[index]
		assert(value)
		cleanup.defer(async () => {
			const dropped = await fetch(
				`${platform.origin}/api/secrets/personal/${encodeURIComponent(owner.id)}/${name}`,
				{
					headers,
					method: "DELETE",
				},
			)
			expect(dropped.status).toBe(200)
			expect(
				(await listSharedSecretNames(platform.env)).has(secretKey(owner, name)),
			).toBe(false)
		})
		const saved =
			index === 0
				? await fetch(`${platform.origin}/api/slates/${slate.id}/secrets/${name}`, {
						body: JSON.stringify({ value }),
						headers,
						method: "PUT",
					})
				: await fetch(chromeUrl, {
						body: new URLSearchParams({ intent: "set-secret", name, value }),
						headers: chromeHeaders,
						method: "POST",
					})
		expect(saved.status).toBe(200)
		const output = await saved.text()
		for (const secretValue of values) expect(output.includes(secretValue)).toBe(false)
		if (index === 0) expect(JSON.parse(output)).toEqual({ name, owner })
		expect((await loadSharedSecret(platform.env, owner, name)) === value).toBe(true)
		if (index === 0) {
			expect(await members()).toEqual([])
			expect(await instance.listSchedules()).toEqual([])
		} else {
			expect(output).toContain("Setup complete")
			expect(await members()).toEqual([{ user_id: owner.id }])
			for (const instance of await workflows.get()) {
				await using workflow = instance
				await workflow.waitForStatus("complete")
			}
			expect(await instance.listSchedules()).toHaveLength(1)
		}
	}
	const logs = JSON.stringify(platform.harness.getLogs())
	for (const value of values) expect(logs.includes(value)).toBe(false)
	expect(logs.includes(vault.CTX_OWNER_CREDENTIALS_DOPPLER_TOKEN)).toBe(false)
})
