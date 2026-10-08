import { resolve } from "node:path"
import {
	readDevelopmentCommandEnv,
	readWebDevelopmentEnv,
} from "@usecontextlayer/dev-env/development"
import { readDevelopmentEnv } from "@usecontextlayer/dev-env/env"
import { execa } from "execa"

const root = resolve(import.meta.dirname, "..")
const webRoot = resolve(root, "../web")
const addresses = readDevelopmentEnv()
const env = await readDevelopmentCommandEnv(
	webRoot,
	await readWebDevelopmentEnv(webRoot, addresses),
	addresses,
)
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
