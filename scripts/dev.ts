import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { initializeDatabase } from "@usecontextlayer/dev-env/database"
import { readDevEnvServiceEnv, readDevEnvWebEnv } from "@usecontextlayer/dev-env/dev-env"
import { startPolarListener } from "@usecontextlayer/dev-env/polar"
import { assignDevEnvPorts, saveDevEnvPorts } from "@usecontextlayer/dev-env/ports"
import seed from "@usecontextlayer/dev-env/seed.json" with { type: "json" }
import { startNext, startVite, startWrangler } from "@usecontextlayer/dev-env/services"
import { execa } from "execa"

process.once("SIGINT", () => process.exit(0))

const { values } = parseArgs({
	options: { "polar-listen": { default: false, type: "boolean" } },
})

const root = resolve(import.meta.dirname, "..")
const webRoot = resolve(root, "../web")
const addresses = await assignDevEnvPorts(root)
const webConfig = await readDevEnvWebEnv(webRoot, addresses)
const clientId = seed.web.client.clientId
const { issuer, platformEnv, polarEnv, webEnv } = await readDevEnvServiceEnv(
	root,
	webConfig,
	addresses,
)

for (const cwd of [root, webRoot]) {
	await execa("docker", ["compose", "up", "-d", "--no-recreate", "--wait", "postgres"], {
		cwd,
		stdio: "inherit",
	})
}
await initializeDatabase(addresses.CTX_PLATFORM_DATABASE_URL, async () => {
	await execa(
		"pnpm",
		[
			"exec",
			"turbo",
			"run",
			"db.latest",
			"--filter=@usecontextlayer/platform",
			"--output-logs=errors-only",
			"--",
			"--no-auto-codegen",
			"--no-auto-biome",
		],
		{ cwd: root, env: platformEnv, stdio: "inherit" },
	)
})
await initializeDatabase(addresses.DATABASE_URL, async () => {
	await execa("pnpm", ["db.latest", "--ci"], {
		cwd: webRoot,
		env: webEnv,
		stdio: "inherit",
	})
})

const web = startNext({ cwd: webRoot, env: webEnv, url: addresses.BETTER_AUTH_URL })
const platform = startVite({
	cwd: resolve(root, "packages/platform"),
	env: platformEnv,
	url: addresses.CTX_PLATFORM_URL,
})
const auth = startWrangler({
	cwd: resolve(root, "packages/auth"),
	env: { CTX_AUTH_ISSUER: issuer },
	url: addresses.CTX_VIEWER_AUTH_URL,
})
const dispatcher = startWrangler({
	cwd: resolve(root, "packages/dispatcher"),
	env: {
		CTX_PLATFORM_URL: platform.url.href,
		CTX_VIEWER_AUTH_URL: auth.url.href,
		POLAR_ACCESS_TOKEN: polarEnv.POLAR_ACCESS_TOKEN,
		POLAR_ENVIRONMENT: polarEnv.POLAR_ENVIRONMENT,
	},
	url: addresses.CTX_DISPATCHER_URL,
})

const services = [web, platform, auth, dispatcher]
const servicesExited = Promise.race(services.map((service) => service.process)).then(
	() => {
		throw new Error("A DevEnv service exited.")
	},
)
await Promise.race([
	Promise.all(services.map((service) => service.ready)),
	servicesExited,
])
const lifetimes: Promise<unknown>[] = [servicesExited]
if (values["polar-listen"]) {
	lifetimes.push(
		startPolarListener(new URL("/api/polar/webhooks", platform.url), polarEnv).then(
			() => {
				throw new Error("The Polar listener exited.")
			},
		),
	)
}
await saveDevEnvPorts(root, { ...addresses, CTX_AUTH_CLIENT_ID: clientId })
console.log(`Web: ${web.url}`)
console.log(`Platform: ${new URL("/dashboard/personal/slates", platform.url)}`)
console.log(`Viewer auth: ${auth.url}`)
console.log(`Dispatcher: ${dispatcher.url}`)
console.log(`CLI issuer: ${issuer}`)
console.log(`CLI client: ${clientId}`)
await Promise.race(lifetimes)
