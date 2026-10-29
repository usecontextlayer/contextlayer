import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { execa } from "execa"

export async function createSlateProject(
	workspaceRoot: string,
	checkout: string,
	{
		installDependencies = false,
		scaffold = "app",
	}: { installDependencies?: boolean; scaffold?: "app" | "mcp" } = {},
) {
	const packagesRoot = join(workspaceRoot, "packages")
	const cli = join(packagesRoot, "cli")
	await mkdir(checkout, { recursive: true })
	await execa(process.execPath, [join(cli, "dist/cli.mjs"), "scaffold", scaffold], {
		cwd: checkout,
	})
	const packages = join(checkout, "packages")
	await mkdir(packages, { recursive: true })
	await Promise.all(
		["cli", "sdk"].map((name) =>
			execa("pnpm", ["pack", "--out", join(packages, `${name}.tgz`)], {
				cwd: join(packagesRoot, name),
			}),
		),
	)
	await appendFile(
		join(checkout, "pnpm-workspace.yaml"),
		"\noverrides:\n  '@usecontextlayer/cli': 'file:packages/cli.tgz'\n  '@usecontextlayer/sdk': 'file:packages/sdk.tgz'\n",
	)
	await execa("pnpm", ["install", ...(installDependencies ? [] : ["--lockfile-only"])], {
		cwd: checkout,
	})
}
