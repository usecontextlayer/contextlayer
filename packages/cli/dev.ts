import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resourcesForConsumer } from "@usecontextlayer/shared/declaration"
import type { Command } from "commander"
import { execa } from "execa"
import { getDefaultDevRegistryPath } from "miniflare"
import type { ViteDevServer } from "vite"
import type { Unstable_Config } from "wrangler"
import { z } from "zod"
import { readLocalSnapshot } from "@/local-source"

const portSchema = z.coerce.number().int().min(0).max(65535)
const devOptionsSchema = z.object({
	port: portSchema.default(8787),
	vitePort: portSchema.optional(),
})

export async function startLocalStack(options: z.input<typeof devOptionsSchema> = {}) {
	const { port, vitePort } = devOptionsSchema.parse(options)
	const directory = process.cwd()
	const snapshot = await readLocalSnapshot(directory)
	const { unstable_DevEnv, unstable_readConfig } = await import("wrangler")
	const runtimeDirectory = fileURLToPath(new URL("./local-runtime/", import.meta.url))
	const config = unstable_readConfig({
		config: resolve(runtimeDirectory, "wrangler.jsonc"),
	})
	const agents = Object.keys(snapshot.agents)
	const subscription = agents.some((name) => {
		const { secrets } = resourcesForConsumer(snapshot.configuration, {
			name,
			type: "agent",
		})
		return (
			!Object.hasOwn(secrets, "ANTHROPIC_API_KEY") &&
			Object.hasOwn(secrets, "CLAUDE_CODE_OAUTH_TOKEN")
		)
	})
	config.containers = config.containers.filter(
		({ class_name }: NonNullable<Unstable_Config["containers"]>[number]) =>
			(class_name === "SlateAgentJob" && agents.length > 0) ||
			(class_name === "Meridian" && subscription),
	)
	const hasVite =
		existsSync(resolve(directory, "package.json")) &&
		["ts", "js", "mts", "mjs", "cts", "cjs"].some((extension) =>
			existsSync(resolve(directory, `vite.config.${extension}`)),
		)
	if (!hasVite && existsSync(resolve(directory, "public")))
		config.assets = {
			directory: resolve(directory, "public"),
			run_worker_first: ["/__ctx/*"],
		}
	const devEnv = new unstable_DevEnv()
	let app: ViteDevServer | undefined
	try {
		// The proxy can be ready before image preparation and runtime registration.
		const runtimeReady = once(devEnv, "reloadComplete")
		const [worker] = await Promise.all([
			devEnv.startWorker({
				bindings: {
					CTX_LOCAL_SNAPSHOT: { type: "secret_text", value: JSON.stringify(snapshot) },
				},
				config,
				dev: {
					containerBuildId: randomUUID().slice(0, 8),
					generateTypes: false,
					inspector: false,
					persist: resolve(directory, ".contextlayer/databases"),
					registry: getDefaultDevRegistryPath(),
					remote: false,
					server: { hostname: "127.0.0.1", port },
					watch: false,
				},
				name: snapshot.scope,
			}),
			runtimeReady,
		])
		for (const slug of Object.keys(snapshot.configuration.databases)) {
			await execa(
				"pnpm",
				[
					"exec",
					"kysely",
					"--no-outdated-check",
					"--config",
					`databases/${slug}/kysely.config.ts`,
					"migrate",
					"latest",
				],
				{ cwd: directory, stdio: "inherit" },
			)
		}
		const provisioned = await worker.fetch(
			new URL("/__ctx/provision", await worker.url),
			{ method: "POST" },
		)
		if (!provisioned.ok)
			throw new Error(`Local schedule provisioning failed: ${await provisioned.text()}`)
		if (hasVite) {
			const require = createRequire(resolve(directory, "package.json"))
			const vite: typeof import("vite") = await import(
				pathToFileURL(require.resolve("vite")).href
			)
			app = await vite.createServer({
				root: directory,
				server: {
					host: "127.0.0.1",
					...(vitePort !== undefined ? { port: vitePort, strictPort: true } : {}),
				},
			})
			await app.listen()
			app.printUrls()
		}
		return {
			app,
			url: await worker.url,
			async [Symbol.asyncDispose]() {
				await app?.close()
				await worker.dispose()
			},
		}
	} catch (error) {
		await app?.close()
		await devEnv.teardown()
		throw error
	}
}

export function addDevCommand(program: Command) {
	program
		.command("dev")
		.description(
			"Run this checkout's native local stack, then its authored Vite app or MCP server when present. Restart after source, declaration, assignment, or environment changes. Docker is required only for agents.",
		)
		.option(
			"--port <port>",
			"Loopback port for the local runtime and static files; 0 selects an available port",
			"8787",
		)
		.option(
			"--vite-port <port>",
			"Loopback port for the authored Vite server; 0 selects an available port",
		)
		.action(async (options) => {
			await using stack = await startLocalStack(options)
			console.log(`Local slate server: ${stack.url}`)
			await new Promise<void>((resolve) => {
				process.once("SIGINT", resolve)
				process.once("SIGTERM", resolve)
			})
		})
}
