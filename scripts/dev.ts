import { resolve } from "node:path"
import { initializeDatabase } from "@usecontextlayer/dev-env/database"
import {
	readDevelopmentServiceEnv,
	readWebDevelopmentEnv,
} from "@usecontextlayer/dev-env/development"
import { startPolarListener } from "@usecontextlayer/dev-env/polar"
import { assignDevelopmentPorts } from "@usecontextlayer/dev-env/ports"
import { startNext, startVite, startWrangler } from "@usecontextlayer/dev-env/services"
import { execa, execaNode } from "execa"
import { z } from "zod"

const root = resolve(import.meta.dirname, "..")
const webRoot = resolve(root, "../web")
const addresses = await assignDevelopmentPorts(root)
const { issuer, platformEnv, polarEnv, webEnv } = await readDevelopmentServiceEnv(
	root,
	await readWebDevelopmentEnv(webRoot, addresses),
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
		throw new Error("A development service exited.")
	},
)
await Promise.race([
	Promise.all(services.map((service) => service.ready)),
	servicesExited,
])
const polarListener = startPolarListener(
	new URL("/api/polar/webhooks", platform.url),
	polarEnv,
)
const exited = Promise.race([servicesExited, polarListener]).then(() => {
	throw new Error("The Polar listener exited.")
})
const { ipcOutput } = await Promise.race([
	execaNode(resolve(webRoot, "scripts/development.mts"), {
		cwd: webRoot,
		env: {
			...webEnv,
			TSX_TSCONFIG_PATH: resolve(webRoot, "tsconfig.tsxrepl.json"),
		},
		ipc: true,
		nodeOptions: ["--import", "tsx"],
		stdio: ["ignore", "inherit", "inherit"],
	}),
	exited,
])
const clientId = z.string().min(1).parse(ipcOutput[0])
console.log(`Web: ${web.url}`)
console.log(`Platform: ${new URL("/dashboard/personal/apps", platform.url)}`)
console.log(`Viewer auth: ${auth.url}`)
console.log(`Dispatcher: ${dispatcher.url}`)
console.log(`CLI issuer: ${issuer}`)
console.log(`CLI client: ${clientId}`)
await exited
