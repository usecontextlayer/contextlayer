import { appendFile, cp, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { initializeSlateSource, type ScaffoldKind } from "@usecontextlayer/cli/scaffold"
import { execa } from "execa"

type SlateProjectOptions = {
	installDependencies?: boolean
	scaffold?: ScaffoldKind | "empty"
}

export async function createSlateProject(
	workspaceRoot: string,
	checkout: string,
	{ installDependencies = false, scaffold = "app" }: SlateProjectOptions = {},
) {
	await initializeSlateSource(checkout, scaffold === "empty" ? [] : [scaffold])
	const packagesRoot = join(workspaceRoot, "packages")
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

export async function copySlateProject(
	checkout: string,
	{ installDependencies = false, scaffold = "app" }: SlateProjectOptions = {},
) {
	await cp(
		resolve(import.meta.dirname, "../../../artifacts/slate-project", scaffold),
		checkout,
		{ recursive: true },
	)
	if (installDependencies) await execa("pnpm", ["install"], { cwd: checkout })
}
