import { resolve } from "node:path"
import { readDevEnvCommandEnv } from "@usecontextlayer/dev-env/dev-env"
import { readDevEnvPorts } from "@usecontextlayer/dev-env/ports"

const root = resolve(import.meta.dirname, "..")
const addresses = await readDevEnvPorts(root)
const env = readDevEnvCommandEnv(root, addresses)
for (const [key, value] of Object.entries(env)) {
	process.stdout.write(`export ${key}='${value.replaceAll("'", "'\\''")}'\n`)
}
