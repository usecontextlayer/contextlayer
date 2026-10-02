import fs from "node:fs"
import path from "node:path"

const PACKAGES_DIR = "packages"

type PackageJson = {
	name?: string
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
	optionalDependencies?: Record<string, string>
}

type TsConfigReference = {
	path?: string
}

type TsConfig = {
	references?: TsConfigReference[]
}

function readJson<T>(filePath: string): T {
	return JSON.parse(fs.readFileSync(filePath, "utf8")) as T
}

function normalizePath(value: string): string {
	return value.replaceAll("\\", "/")
}

function collectPackageDirectories(): string[] {
	return fs
		.readdirSync(PACKAGES_DIR)
		.filter((name) => fs.existsSync(path.join(PACKAGES_DIR, name, "package.json")))
}

function collectWorkspaceIndex(packageDirs: string[]): Map<string, string> {
	const index = new Map<string, string>()
	for (const dir of packageDirs) {
		const packageJsonPath = path.join(PACKAGES_DIR, dir, "package.json")
		const packageJson = readJson<PackageJson>(packageJsonPath)
		if (typeof packageJson.name !== "string" || packageJson.name.length === 0) {
			continue
		}
		index.set(packageJson.name, dir)
	}
	return index
}

function expectedReferencePath(fromDir: string, toDir: string): string {
	return normalizePath(
		path.relative(path.join(PACKAGES_DIR, fromDir), path.join(PACKAGES_DIR, toDir)),
	)
}

function resolveReferencePath(fromDir: string, referencePath: string): string {
	return normalizePath(path.resolve(path.join(PACKAGES_DIR, fromDir), referencePath))
}

function collectLocalDependencyNames(
	packageJson: PackageJson,
	workspaceByName: Map<string, string>,
): string[] {
	const dependencySets = [
		packageJson.dependencies ?? {},
		packageJson.devDependencies ?? {},
		packageJson.peerDependencies ?? {},
		packageJson.optionalDependencies ?? {},
	]

	const names = new Set<string>()
	for (const deps of dependencySets) {
		for (const name of Object.keys(deps)) {
			if (workspaceByName.has(name)) {
				names.add(name)
			}
		}
	}
	return [...names]
}

function main(): void {
	const packageDirs = collectPackageDirectories()
	const workspaceByName = collectWorkspaceIndex(packageDirs)
	const errors: string[] = []

	for (const packageDir of packageDirs) {
		const packageJsonPath = path.join(PACKAGES_DIR, packageDir, "package.json")
		const tsconfigPath = path.join(PACKAGES_DIR, packageDir, "tsconfig.json")

		const packageJson = readJson<PackageJson>(packageJsonPath)
		const localDependencyNames = collectLocalDependencyNames(packageJson, workspaceByName)
		if (localDependencyNames.length === 0) {
			continue
		}

		if (!fs.existsSync(tsconfigPath)) {
			errors.push(
				`${packageDir}: missing tsconfig.json (required for workspace dependencies).`,
			)
			continue
		}

		const tsconfig = readJson<TsConfig>(tsconfigPath)
		const references = Array.isArray(tsconfig.references) ? tsconfig.references : []
		const normalizedReferenceTargets = new Set<string>(
			references
				.map((entry) =>
					entry && typeof entry.path === "string"
						? resolveReferencePath(packageDir, entry.path)
						: null,
				)
				.filter((value): value is string => value !== null),
		)

		for (const dependencyName of localDependencyNames) {
			const dependencyDir = workspaceByName.get(dependencyName)
			if (!dependencyDir) {
				continue
			}
			const dependencyAbsolutePath = normalizePath(
				path.resolve(path.join(PACKAGES_DIR, dependencyDir)),
			)
			if (!normalizedReferenceTargets.has(dependencyAbsolutePath)) {
				errors.push(
					`${packageDir}: missing tsconfig reference '${expectedReferencePath(packageDir, dependencyDir)}' for '${dependencyName}'.`,
				)
			}
		}
	}

	if (errors.length > 0) {
		console.error("Workspace reference check failed:")
		for (const error of errors) {
			console.error(`- ${error}`)
		}
		process.exitCode = 1
		return
	}

	console.log("Workspace reference check passed.")
}

main()
