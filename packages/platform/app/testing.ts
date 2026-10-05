import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:net"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { PlatformConfig } from "@/env"

export async function startPlatformWorker(
	config: PlatformConfig,
	env: NodeJS.ProcessEnv,
) {
	const socket = createServer()
	socket.listen(0, "127.0.0.1")
	await once(socket, "listening")
	const address = socket.address()
	if (!address || typeof address === "string") throw new Error("Expected TCP address")
	await new Promise<void>((resolve) => socket.close(() => resolve()))
	const server = spawn(
		process.execPath,
		[
			"node_modules/wrangler/bin/wrangler.js",
			"dev",
			"build/server/index.js",
			"--config",
			"wrangler.jsonc",
			"--no-bundle",
			"--ip",
			"127.0.0.1",
			"--port",
			String(address.port),
		],
		{
			cwd: join(import.meta.dirname, ".."),
			env: { ...env, ...config },
			stdio: ["ignore", "pipe", "pipe"],
		},
	)
	const exited = once(server, "exit")
	let output = ""
	const lines = createInterface({
		input: server.stdout.map((chunk) => {
			output += chunk
			return chunk
		}),
	})
	const ready = new Promise<string>((resolve, reject) => {
		lines.on("line", (line) => {
			const match = line.match(/http:\/\/127\.0\.0\.1:\d+/)
			if (match) resolve(match[0])
		})
		lines.on("close", () => reject(new Error("Platform Worker ended before readiness")))
	})
	server.stderr.on("data", (chunk) => {
		output += chunk
	})
	return {
		exited,
		get output() {
			return output
		},
		ready,
		server,
	}
}
