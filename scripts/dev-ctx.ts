import { resolve } from "node:path"
import { readDevelopmentCommandEnv } from "@usecontextlayer/dev-env/development"
import { readDevelopmentPorts } from "@usecontextlayer/dev-env/ports"
import { execa } from "execa"

const root = resolve(import.meta.dirname, "..")
const addresses = await readDevelopmentPorts(root)
const env = readDevelopmentCommandEnv(root, addresses)
const result = await execa(
	process.execPath,
	[resolve(root, "packages/cli/dist/cli.mjs"), ...process.argv.slice(2)],
	{
		env,
		reject: false,
		stdio: "inherit",
	},
)
process.exitCode = result.exitCode
