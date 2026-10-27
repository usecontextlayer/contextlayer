import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { readDevEnvCommandEnv } from "@/dev-env"
import { readDevEnv } from "@/env"
import { readDevEnvPorts, saveDevEnvPorts } from "@/ports"

const directories: string[] = []

afterEach(async () => {
	vi.unstubAllEnvs()
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	)
})

test("reads initialized DevEnv command settings without web or provider discovery", async () => {
	const directory = await mkdtemp(join(tmpdir(), "dev-env-command-"))
	directories.push(directory)
	vi.stubEnv("CTX_CONFIG_DIR", join(directory, "other-account"))
	const addresses = {
		...readDevEnv(),
		BETTER_AUTH_URL: new URL("http://localhost:43001/"),
		CTX_DISPATCHER_URL: new URL("http://localhost:43004/"),
		CTX_PLATFORM_URL: new URL("http://localhost:43002/"),
		CTX_VIEWER_AUTH_URL: new URL("http://localhost:43003/"),
	}
	await saveDevEnvPorts(directory, { ...addresses, CTX_AUTH_CLIENT_ID: "local-cli" })
	const settings = readDevEnvCommandEnv(directory, await readDevEnvPorts(directory))
	expect(settings).toEqual({
		BETTER_AUTH_URL: "http://localhost:43001/",
		CTX_AUTH_CLIENT_ID: "local-cli",
		CTX_AUTH_ISSUER: "http://localhost:43001/api/auth",
		CTX_CLI_COMMAND: `pnpm --silent -C '${directory}' dev:ctx`,
		CTX_CONFIG_DIR: join(directory, ".contextlayer/cli"),
		CTX_DISPATCHER_URL: "http://localhost:43004/",
		CTX_PLATFORM_DATABASE_URL: addresses.CTX_PLATFORM_DATABASE_URL,
		CTX_PLATFORM_URL: "http://localhost:43002/",
		CTX_VIEWER_AUTH_URL: "http://localhost:43003/",
		DATABASE_URL: addresses.DATABASE_URL,
	})
})
