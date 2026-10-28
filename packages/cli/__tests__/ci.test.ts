import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { execa } from "execa"
import { expect, test } from "vitest"

test("inspection launchers delegate to the shipped native client without a login for help", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ctx-ci-help-"))
	try {
		const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url))
		for (const [args, expected] of [
			[["ci", "slate.example.com", "--help"], /^cf workflows instances$/m],
			[["ci", "--help"], /list --page <number>/],
			[
				["worker", "slate.example.com", "get", "--help"],
				/^cf workers-for-platforms dispatch-namespaces scripts get <script-name>$/m,
			],
		] as const) {
			const result = await execa(process.execPath, [cli, ...args], {
				env: {
					CTX_AUTH_CLIENT_ID: "help-only",
					CTX_AUTH_ISSUER: "http://localhost:1/api/auth",
					CTX_CONFIG_DIR: directory,
					CTX_PLATFORM_URL: "http://localhost:1",
				},
				reject: false,
			})
			expect(result.exitCode, result.stderr).toBe(0)
			expect(result.stdout).toMatch(expected)
		}
	} finally {
		await rm(directory, { force: true, recursive: true })
	}
})
