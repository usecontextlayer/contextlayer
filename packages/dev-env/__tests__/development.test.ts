import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { readDevelopmentCommandEnv } from "@/development"
import { readDevelopmentEnv } from "@/env"
import { readDevelopmentPorts, saveDevelopmentPorts } from "@/ports"

const directories: string[] = []

afterEach(async () => {
	vi.unstubAllEnvs()
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	)
})

test("reads initialized local command settings without web or provider discovery", async () => {
	const directory = await mkdtemp(join(tmpdir(), "development-command-"))
	directories.push(directory)
	vi.stubEnv("CTX_CONFIG_DIR", join(directory, "other-account"))
	const addresses = {
		...readDevelopmentEnv(directory),
		BETTER_AUTH_URL: new URL("http://localhost:43001/"),
		CTX_DISPATCHER_URL: new URL("http://localhost:43004/"),
		CTX_PLATFORM_URL: new URL("http://localhost:43002/"),
		CTX_VIEWER_AUTH_URL: new URL("http://localhost:43003/"),
	}
	await saveDevelopmentPorts(directory, { ...addresses, CTX_AUTH_CLIENT_ID: "local-cli" })
	const settings = readDevelopmentCommandEnv(
		directory,
		await readDevelopmentPorts(directory),
	)
	expect(settings).toEqual({
		BETTER_AUTH_URL: "http://localhost:43001/",
		CTX_AUTH_CLIENT_ID: "local-cli",
		CTX_AUTH_ISSUER: "http://localhost:43001/api/auth",
		CTX_CONFIG_DIR: join(directory, ".contextlayer/cli"),
		CTX_DISPATCHER_URL: "http://localhost:43004/",
		CTX_PLATFORM_DATABASE_URL: addresses.CTX_PLATFORM_DATABASE_URL,
		CTX_PLATFORM_URL: "http://localhost:43002/",
		CTX_VIEWER_AUTH_URL: "http://localhost:43003/",
		DATABASE_URL: addresses.DATABASE_URL,
	})
})
