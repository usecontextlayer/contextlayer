import { resolve } from "node:path"
import { readDevEnvCommandEnv } from "@usecontextlayer/dev-env/dev-env"
import { readDevEnvPorts } from "@usecontextlayer/dev-env/ports"
import { execa } from "execa"

const root = resolve(import.meta.dirname, "..")
const addresses = await readDevEnvPorts(root)
const env = readDevEnvCommandEnv(root, addresses)
const result = await execa(
	process.execPath,
	[resolve(root, "packages/cli/dist/cli.mjs"), ...process.argv.slice(2)],
	{
		cwd: process.env.INIT_CWD,
		env,
		reject: false,
		stdio: "inherit",
	},
)
process.exitCode = result.exitCode
