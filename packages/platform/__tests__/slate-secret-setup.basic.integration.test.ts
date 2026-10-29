import { test } from "@tests/slate-secret-setup"
import { expect } from "vitest"
import { z } from "zod"

test("non-writing: chrome lists agent-only personal secrets and rejects invalid and undeclared saves", {
	timeout: 180_000,
}, async ({ platform, secretSlate }) => {
	const { chromeHeaders, chromeUrl, headers, instance, members, names, slate } =
		secretSlate
	const chrome = await fetch(chromeUrl, { headers: chromeHeaders })
	expect(chrome.status).toBe(200)
	const html = await chrome.text()
	for (const name of names) expect(html).toContain(name)
	expect(html).toContain("2 inputs to configure")
	const invalid = await fetch(chromeUrl, {
		body: new URLSearchParams({ intent: "set-secret", name: names[0], value: "" }),
		headers: chromeHeaders,
		method: "POST",
	})
	expect(invalid.status).toBe(400)
	const undeclared = await fetch(
		`${platform.origin}/api/slates/${slate.id}/secrets/NOT_DECLARED`,
		{
			body: JSON.stringify({ value: "synthetic-not-saved" }),
			headers,
			method: "PUT",
		},
	)
	expect(undeclared.status).toBe(404)
	const schema = z
		.object({ paths: z.record(z.string(), z.unknown()) })
		.parse(await (await fetch(`${platform.origin}/api/openapi.json`)).json())
	expect(schema.paths["/slates/{target}/secrets/{name}"]).toEqual(
		expect.objectContaining({
			put: expect.objectContaining({ operationId: "setSlateSecret" }),
		}),
	)
	expect(await members()).toEqual([])
	expect(await instance.listSchedules()).toEqual([])
})
