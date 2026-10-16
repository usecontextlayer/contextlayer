import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test as base, expect } from "vitest"
import { developmentServiceKeys } from "@/env"
import {
	assignDevelopmentPorts,
	readDevelopmentPorts,
	saveDevelopmentPorts,
} from "@/ports"

// biome-ignore lint/correctness/noEmptyPattern: Vitest identifies fixture dependencies by destructuring.
const test = base.extend("directory", async ({}, { onCleanup }) => {
	const directory = await mkdtemp(join(tmpdir(), "development-ports-"))
	onCleanup(() => rm(directory, { force: true, recursive: true }))
	return directory
})

test("publishes selected service URLs and the initialized CLI client for another command", async ({
	directory,
}) => {
	const addresses = await assignDevelopmentPorts(directory)
	await expect(readFile(join(directory, ".env.json"))).rejects.toMatchObject({
		code: "ENOENT",
	})
	await saveDevelopmentPorts(directory, { ...addresses, CTX_AUTH_CLIENT_ID: "local-cli" })
	expect(await readDevelopmentPorts(directory)).toEqual({
		...addresses,
		CTX_AUTH_CLIENT_ID: "local-cli",
	})
	expect(new Set(developmentServiceKeys.map((key) => addresses[key].port)).size).toBe(4)
	await using servers = new AsyncDisposableStack()
	for (const key of developmentServiceKeys) {
		const url = addresses[key]
		expect(Number(url.port)).toBeGreaterThanOrEqual(3000)
		const server = servers.use(createServer())
		server.listen({ host: url.hostname, port: Number(url.port) })
		await once(server, "listening")
	}
})

test("reuses the complete saved set when its ports are free", async ({ directory }) => {
	const first = await assignDevelopmentPorts(directory)
	await saveDevelopmentPorts(directory, { ...first, CTX_AUTH_CLIENT_ID: "local-cli" })
	expect(await assignDevelopmentPorts(directory)).toEqual(first)
})

test("replaces every port when one saved port is occupied", async ({ directory }) => {
	const first = await assignDevelopmentPorts(directory)
	await saveDevelopmentPorts(directory, { ...first, CTX_AUTH_CLIENT_ID: "local-cli" })
	await using occupied = createServer()
	occupied.listen({ host: "127.0.0.1", port: Number(first.CTX_PLATFORM_URL.port) })
	await once(occupied, "listening")
	const next = await assignDevelopmentPorts(directory)
	const previousPorts = developmentServiceKeys.map((key) => first[key].port)
	for (const key of developmentServiceKeys) {
		expect(previousPorts).not.toContain(next[key].port)
	}
	await saveDevelopmentPorts(directory, { ...next, CTX_AUTH_CLIENT_ID: "next-local-cli" })
	expect(await readDevelopmentPorts(directory)).toEqual({
		...next,
		CTX_AUTH_CLIENT_ID: "next-local-cli",
	})
})
