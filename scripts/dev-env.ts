import { resolve } from "node:path"
import { readDevelopmentCommandEnv } from "@usecontextlayer/dev-env/development"
import { readDevelopmentPorts } from "@usecontextlayer/dev-env/ports"

const root = resolve(import.meta.dirname, "..")
const addresses = await readDevelopmentPorts(root)
const env = readDevelopmentCommandEnv(root, addresses)
for (const [key, value] of Object.entries(env)) {
	process.stdout.write(`export ${key}='${value.replaceAll("'", "'\\''")}'\n`)
}
