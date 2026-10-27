import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { test as base, expect } from "vitest"
import { devEnvServiceKeys } from "@/env"
import { assignDevEnvPorts, readDevEnvPorts, saveDevEnvPorts } from "@/ports"

// biome-ignore lint/correctness/noEmptyPattern: Vitest identifies fixture dependencies by destructuring.
const test = base.extend("directory", async ({}, { onCleanup }) => {
	const directory = await mkdtemp(join(tmpdir(), "dev-env-ports-"))
	onCleanup(() => rm(directory, { force: true, recursive: true }))
	return directory
})

test("publishes selected service URLs and the initialized CLI client for another command", async ({
	directory,
}) => {
	const addresses = await assignDevEnvPorts(directory)
	await expect(readFile(join(directory, ".env.json"))).rejects.toMatchObject({
		code: "ENOENT",
	})
	await saveDevEnvPorts(directory, { ...addresses, CTX_AUTH_CLIENT_ID: "local-cli" })
	expect(await readDevEnvPorts(directory)).toEqual({
		...addresses,
		CTX_AUTH_CLIENT_ID: "local-cli",
	})
	expect(new Set(devEnvServiceKeys.map((key) => addresses[key].port)).size).toBe(4)
	await using servers = new AsyncDisposableStack()
	for (const key of devEnvServiceKeys) {
		const url = addresses[key]
		expect(Number(url.port)).toBeGreaterThanOrEqual(3000)
		const server = servers.use(createServer())
		server.listen({ host: url.hostname, port: Number(url.port) })
		await once(server, "listening")
	}
})

test("reuses the complete saved set when its ports are free", async ({ directory }) => {
	const first = await assignDevEnvPorts(directory)
	await saveDevEnvPorts(directory, { ...first, CTX_AUTH_CLIENT_ID: "local-cli" })
	expect(await assignDevEnvPorts(directory)).toEqual(first)
})

test("replaces every port when one saved port is occupied", async ({ directory }) => {
	const first = await assignDevEnvPorts(directory)
	await saveDevEnvPorts(directory, { ...first, CTX_AUTH_CLIENT_ID: "local-cli" })
	await using occupied = createServer()
	occupied.listen({ host: "127.0.0.1", port: Number(first.CTX_PLATFORM_URL.port) })
	await once(occupied, "listening")
	const next = await assignDevEnvPorts(directory)
	const previousPorts = devEnvServiceKeys.map((key) => first[key].port)
	for (const key of devEnvServiceKeys) {
		expect(previousPorts).not.toContain(next[key].port)
	}
	await saveDevEnvPorts(directory, { ...next, CTX_AUTH_CLIENT_ID: "next-local-cli" })
	expect(await readDevEnvPorts(directory)).toEqual({
		...next,
		CTX_AUTH_CLIENT_ID: "next-local-cli",
	})
})

test("selects the checkout's own platform database", async ({ directory }) => {
	const addresses = await assignDevEnvPorts(directory)
	expect(new URL(addresses.CTX_PLATFORM_DATABASE_URL).pathname).toBe(
		`/${basename(directory)}_platform`,
	)
})
