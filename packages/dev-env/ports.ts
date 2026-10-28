import { once } from "node:events"
import { readFile, writeFile } from "node:fs/promises"
import { type AddressInfo, createServer } from "node:net"
import { basename, resolve } from "node:path"
import waitOn from "wait-on"
import {
	type DevEnvPorts,
	devEnvServiceKeys,
	parseDevEnvPorts,
	parseDevEnvServiceUrls,
	readDevEnv,
} from "@/env"

const MINIMUM_PORT = 3000

async function readSavedPorts(root: string): Promise<unknown> {
	const contents = await readFile(resolve(root, ".env.json"), "utf8").catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined
			throw error
		},
	)
	return contents === undefined ? undefined : JSON.parse(contents)
}

export async function readDevEnvPorts(root: string) {
	const ports = await readSavedPorts(root)
	if (ports === undefined)
		throw new Error("Start this checkout's DevEnv with pnpm dev before running commands.")
	return { ...readDevEnv(), ...parseDevEnvPorts(ports) }
}

export async function saveDevEnvPorts(root: string, ports: DevEnvPorts) {
	const values = {
		...Object.fromEntries(devEnvServiceKeys.map((key) => [key, ports[key]])),
		CTX_AUTH_CLIENT_ID: ports.CTX_AUTH_CLIENT_ID,
		CTX_PLATFORM_DATABASE_URL: ports.CTX_PLATFORM_DATABASE_URL,
		DATABASE_URL: ports.DATABASE_URL,
	}
	await writeFile(resolve(root, ".env.json"), `${JSON.stringify(values, null, 2)}\n`)
}

export async function assignDevEnvPorts(root: string) {
	const previous = await readSavedPorts(root)
	const saved = previous === undefined ? undefined : parseDevEnvServiceUrls(previous)
	const env = readDevEnv()
	// Branch migrations must not share a platform database across checkouts.
	const database = new URL(env.CTX_PLATFORM_DATABASE_URL)
	database.pathname = `/${basename(root)}_platform`
	const addresses = { ...env, ...saved, CTX_PLATFORM_DATABASE_URL: database.href }
	const previousPorts = devEnvServiceKeys.map((key) => Number(addresses[key].port))
	if (saved && previousPorts.every((port) => port >= MINIMUM_PORT)) {
		try {
			await waitOn({
				resources: devEnvServiceKeys.map(
					(key) => `tcp:${saved[key].hostname}:${saved[key].port}`,
				),
				reverse: true,
				timeout: 1000,
				window: 0,
			})
			return addresses
		} catch (error) {
			if (
				!(error instanceof Error && error.message.startsWith("Timed out waiting for:"))
			) {
				throw error
			}
		}
	}
	const selected = await Promise.all(
		devEnvServiceKeys.map(async (key) => {
			let port: number
			do {
				await using server = createServer()
				server.listen(0)
				await once(server, "listening")
				port = (server.address() as AddressInfo).port
			} while (port < MINIMUM_PORT || previousPorts.includes(port))
			const url = new URL(addresses[key])
			url.port = String(port)
			return [key, url.href] as const
		}),
	)
	const values = Object.fromEntries(selected)
	return { ...addresses, ...parseDevEnvServiceUrls(values) }
}
