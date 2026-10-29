import { join } from "node:path"
import { test as base } from "@tests/integration"
import { execa } from "execa"

const cli = join(import.meta.dirname, "../../cli/dist/cli.mjs")
export const runCli = (env: Record<string, string>, args: string[], input = "") =>
	execa(process.execPath, [cli, ...args], {
		all: true,
		env,
		input,
		reject: false,
	})
export const test = base.extend(
	"runCli",
	({ cliEnv }) =>
		(args: string[], input = "") =>
			runCli(cliEnv, args, input),
)
