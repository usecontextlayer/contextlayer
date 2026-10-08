import { once } from "node:events"
import { readFile, writeFile } from "node:fs/promises"
import { type AddressInfo, createServer } from "node:net"
import { resolve } from "node:path"
import waitOn from "wait-on"
import {
	developmentServiceKeys,
	parseDevelopmentServiceUrls,
	readDevelopmentEnv,
} from "@/env"

const MINIMUM_PORT = 3000

async function readSavedPorts(root: string) {
	const contents = await readFile(resolve(root, ".ports"), "utf8").catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined
			throw error
		},
	)
	return contents === undefined
		? undefined
		: parseDevelopmentServiceUrls(JSON.parse(contents))
}

export async function readDevelopmentPorts(root: string) {
	const ports = await readSavedPorts(root)
	if (!ports)
		throw new Error(
			"Start this checkout with pnpm dev before running connected commands.",
		)
	return { ...readDevelopmentEnv(), ...ports }
}

export async function assignDevelopmentPorts(root: string) {
	const saved = await readSavedPorts(root)
	const addresses = { ...readDevelopmentEnv(), ...saved }
	const previousPorts = developmentServiceKeys.map((key) => Number(addresses[key].port))
	if (saved && previousPorts.every((port) => port >= MINIMUM_PORT)) {
		try {
			await waitOn({
				resources: developmentServiceKeys.map(
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
		developmentServiceKeys.map(async (key) => {
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
	await writeFile(resolve(root, ".ports"), `${JSON.stringify(values, null, 2)}\n`)
	return { ...addresses, ...parseDevelopmentServiceUrls(values) }
}
