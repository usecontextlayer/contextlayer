import { resolve } from "node:path"
import {
	readDevelopmentCommandEnv,
	readWebDevelopmentEnv,
} from "@usecontextlayer/dev-env/development"
import { readDevelopmentPorts } from "@usecontextlayer/dev-env/ports"

const root = resolve(import.meta.dirname, "..")
const webRoot = resolve(root, "../web")
const addresses = await readDevelopmentPorts(root)
const env = await readDevelopmentCommandEnv(
	webRoot,
	await readWebDevelopmentEnv(webRoot, addresses),
	addresses,
)
for (const [key, value] of Object.entries(env)) {
	process.stdout.write(`export ${key}='${value.replaceAll("'", "'\\''")}'\n`)
}
