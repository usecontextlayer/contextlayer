import { resolve } from "node:path"
import {
	readDevelopmentCommandEnv,
	readWebDevelopmentEnv,
} from "@usecontextlayer/dev-env/development"
import { readDevelopmentEnv } from "@usecontextlayer/dev-env/env"

const webRoot = resolve(import.meta.dirname, "../../web")
const addresses = readDevelopmentEnv()
const env = await readDevelopmentCommandEnv(
	webRoot,
	await readWebDevelopmentEnv(webRoot, addresses),
	addresses,
)
for (const [key, value] of Object.entries(env)) {
	process.stdout.write(`export ${key}='${value.replaceAll("'", "'\\''")}'\n`)
}
