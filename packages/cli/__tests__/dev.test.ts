import { fileURLToPath } from "node:url"
import { execa } from "execa"
import { expect, test } from "vitest"

const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url))

test("ctx dev exposes local server and authored Vite port options", async () => {
	const help = await execa(process.execPath, [cli, "dev", "--help"])
	expect(help.stdout).toContain("--port <port>")
	expect(help.stdout).toContain("--vite-port <port>")
})

test.each([
	["--port", "port"],
	["--vite-port", "vitePort"],
])("ctx dev validates %s before starting infrastructure", async (option, field) => {
	const invalid = await execa(process.execPath, [cli, "dev", option, "65536"], {
		reject: false,
	})
	expect(invalid.exitCode).toBe(1)
	expect(invalid.stderr).toContain(field)
})
