import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test as base, expect } from "vitest"
import { developmentServiceKeys } from "@/env"
import { assignDevelopmentPorts, readDevelopmentPorts } from "@/ports"

// biome-ignore lint/correctness/noEmptyPattern: Vitest identifies fixture dependencies by destructuring.
const test = base.extend("directory", async ({}, { onCleanup }) => {
	const directory = await mkdtemp(join(tmpdir(), "development-ports-"))
	onCleanup(() => rm(directory, { force: true, recursive: true }))
	return directory
})

test("assigns distinct available ports and shares their URLs with another command", async ({
	directory,
}) => {
	const addresses = await assignDevelopmentPorts(directory)
	expect(await readDevelopmentPorts(directory)).toEqual(addresses)
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
	expect(await assignDevelopmentPorts(directory)).toEqual(first)
})

test("replaces every port when one saved port is occupied", async ({ directory }) => {
	const first = await assignDevelopmentPorts(directory)
	await using occupied = createServer()
	occupied.listen({ host: "127.0.0.1", port: Number(first.CTX_PLATFORM_URL.port) })
	await once(occupied, "listening")
	const next = await assignDevelopmentPorts(directory)
	const previousPorts = developmentServiceKeys.map((key) => first[key].port)
	for (const key of developmentServiceKeys) {
		expect(previousPorts).not.toContain(next[key].port)
	}
	expect(await readDevelopmentPorts(directory)).toEqual(next)
})
