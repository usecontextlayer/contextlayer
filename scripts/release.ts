import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

// Workspace package versions and the operator-side release ladder.
// Public/private classification comes from each npm manifest's private field.
// Bumps synchronize pnpm-lock.yaml; dry runs write nothing and run no git.
//
// Subcommands (node --import tsx scripts/release.ts ...):
//   audit                                - list packages, versions and publish status
//   verify [<version>]                   - check manifest version consistency
//   publish-list npm                     - public package directories for release.yml
//   bump <version|patch|minor|major> [--dry-run]
//                                        - update manifests and synchronize the lockfile
//   <version|patch|minor|major> [--until=<rung>] [--dry-run]
//                                        - bump, commit, push, check, tag and release
//
// Main pushes start check.yml; version-tag pushes start release.yml.
// --until defaults to 5-push-tag; 6-release waits for publication to finish.
// Resume with an explicit version: patch/minor/major resolve against the current
// manifests, so repeating a bump word after the bump advances the version again.

const PACKAGES_DIR = "packages"
const LOCKFILE_PATH = "pnpm-lock.yaml"

const VERSION_RE = /^\d+\.\d+\.\d+$/
const UNVERSIONED = "(unversioned)"

type PackageInfo = {
	dir: string
	manifestPath: string
	distributionName: string
	version: string
	isPrivate: boolean
	privateReason: string | null
}

type NpmManifest = {
	name?: string
	version?: string
	private?: boolean
}

function readJson<T>(filePath: string): T {
	return JSON.parse(fs.readFileSync(filePath, "utf8")) as T
}

function collectNpmPackages(): PackageInfo[] {
	const dirs = fs
		.readdirSync(PACKAGES_DIR)
		.filter((name) => fs.existsSync(path.join(PACKAGES_DIR, name, "package.json")))
	const result: PackageInfo[] = []
	for (const dir of dirs) {
		const manifestPath = path.join(PACKAGES_DIR, dir, "package.json")
		const manifest = readJson<NpmManifest>(manifestPath)
		const name = manifest.name
		if (typeof name !== "string" || name.length === 0) {
			throw new Error(`${manifestPath}: missing or empty "name" field`)
		}
		const isPrivate = manifest.private === true
		const version = manifest.version
		if (!isPrivate && (typeof version !== "string" || version.length === 0)) {
			throw new Error(
				`${manifestPath}: public package missing "version" (required for publish)`,
			)
		}
		result.push({
			dir,
			distributionName: name,
			isPrivate,
			manifestPath,
			privateReason: isPrivate ? '"private": true' : null,
			version: typeof version === "string" ? version : "(unversioned)",
		})
	}
	return result
}

function assertNoDuplicateDistributionNames(packages: PackageInfo[]): void {
	const byName = new Map<string, string[]>()
	for (const pkg of packages) {
		const key = pkg.distributionName
		const list = byName.get(key) ?? []
		list.push(pkg.manifestPath)
		byName.set(key, list)
	}
	const collisions = [...byName.entries()].filter(([, paths]) => paths.length > 1)
	if (collisions.length > 0) {
		const lines = collisions.map(
			([key, paths]) => `  ${key}\n    ${paths.join("\n    ")}`,
		)
		throw new Error(`Duplicate distribution names:\n${lines.join("\n")}`)
	}
}

function formatAudit(packages: PackageInfo[]): string {
	const lines: string[] = []
	const groups: Array<{
		isPrivate: boolean
		label: string
	}> = [
		{ isPrivate: false, label: "npm (public, will publish):" },
		{ isPrivate: true, label: "npm (private, bumped only):" },
	]
	for (const group of groups) {
		const entries = packages
			.filter((p) => p.isPrivate === group.isPrivate)
			.sort((a, b) => a.distributionName.localeCompare(b.distributionName))
		lines.push(group.label)
		if (entries.length === 0) {
			lines.push("  (none)")
		} else {
			for (const entry of entries) {
				const suffix = entry.privateReason ? `    [${entry.privateReason}]` : ""
				lines.push(
					`  ${entry.distributionName.padEnd(40)} ${entry.version.padEnd(8)} ${entry.dir}${suffix}`,
				)
			}
		}
		lines.push("")
	}

	const publishCount = packages.filter((p) => !p.isPrivate).length
	const privateCount = packages.filter((p) => p.isPrivate).length
	lines.push(
		`Total: ${packages.length} packages (${publishCount} will publish, ${privateCount} bumped only)`,
	)
	return lines.join("\n")
}

function runAudit(): void {
	const allPackages = collectNpmPackages()
	assertNoDuplicateDistributionNames(allPackages)
	console.log(formatAudit(allPackages))
}

// The publish list the release workflow consumes, one package directory per
// line for a shell loop. It shares `audit`'s classifier rather than maintaining
// a separate hardcoded list.
// Emitting the classification here makes the audit's "will publish" true by
// construction, and a new non-private package needs no workflow edit.
function runPublishList(ecosystem: string | undefined): void {
	if (ecosystem !== "npm") {
		throw new Error(
			`publish-list takes one ecosystem (npm), got '${ecosystem ?? ""}'.\n${USAGE}`,
		)
	}
	const packages = collectNpmPackages()
	for (const pkg of packages.filter((entry) => !entry.isPrivate)) {
		console.log(path.dirname(pkg.manifestPath))
	}
}

// JSON write helpers. Biome's `useSortedKeys` assist sorts package.json keys
// alphabetically; matching that on write produces zero diff drift on existing
// (already-sorted) manifests and inserts new fields like `version` in their
// correct alphabetical position. Tab indent + trailing newline match the rest
// of the repo.
function deepSortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(deepSortKeys)
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
		entries.sort(([a], [b]) => a.localeCompare(b))
		const sorted: Record<string, unknown> = {}
		for (const [k, v] of entries) sorted[k] = deepSortKeys(v)
		return sorted
	}
	return value
}

function stringifyNpmManifest(obj: unknown): string {
	return `${JSON.stringify(deepSortKeys(obj), null, "\t")}\n`
}

function rewriteWorkspaceExactPins(deps: unknown, newVersion: string): void {
	if (deps === null || typeof deps !== "object") return
	const entries = deps as Record<string, string>
	for (const key of Object.keys(entries)) {
		if (!key.startsWith("@usecontextlayer/")) continue
		const spec = entries[key]
		if (spec === undefined || !VERSION_RE.test(spec)) continue
		entries[key] = newVersion
	}
}

function bumpNpmManifest(content: string, newVersion: string): string {
	const obj = JSON.parse(content) as Record<string, unknown>
	obj.version = newVersion
	rewriteWorkspaceExactPins(obj.dependencies, newVersion)
	rewriteWorkspaceExactPins(obj.devDependencies, newVersion)
	rewriteWorkspaceExactPins(obj.optionalDependencies, newVersion)
	rewriteWorkspaceExactPins(obj.peerDependencies, newVersion)
	return stringifyNpmManifest(obj)
}

type BumpChange = {
	manifestPath: string
	beforeContent: string
	afterContent: string
}

function planBump(version: string): BumpChange[] {
	const npmPackages = collectNpmPackages()
	assertNoDuplicateDistributionNames(npmPackages)
	const changes: BumpChange[] = []
	for (const pkg of npmPackages) {
		const before = fs.readFileSync(pkg.manifestPath, "utf8")
		const after = bumpNpmManifest(before, version)
		if (before !== after) {
			changes.push({
				afterContent: after,
				beforeContent: before,
				manifestPath: pkg.manifestPath,
			})
		}
	}
	return changes
}

// Reconciles pnpm-lock.yaml with the just-bumped manifests. pnpm references
// workspace members via `link:` (not pinned versions), so a pure version bump
// usually leaves the lockfile untouched — but re-locking is cheap and keeps it
// consistent when a bump also changes a dep specifier. `--lockfile-only`
// rewrites pnpm-lock.yaml without touching node_modules.
function syncLockfile(): void {
	if (!fs.existsSync(LOCKFILE_PATH)) {
		console.log(`No ${LOCKFILE_PATH} to sync — skipping.`)
		return
	}
	console.log(`\nSyncing ${LOCKFILE_PATH} via pnpm install --lockfile-only...`)
	const result = spawnSync("pnpm", ["install", "--lockfile-only"], {
		stdio: "inherit",
	})
	if (result.status !== 0) {
		throw new Error(`pnpm install --lockfile-only exited with status ${result.status}.`)
	}
	console.log("Lockfile synced.")
}

function runBump(version: string, dryRun: boolean): void {
	if (!VERSION_RE.test(version)) {
		console.error(
			`Invalid version "${version}". Expected MAJOR.MINOR.PATCH (e.g., 0.2.0).`,
		)
		process.exitCode = 1
		return
	}
	const changes = planBump(version)
	if (changes.length === 0) {
		console.log(`No changes needed: every manifest already at ${version}.`)
		if (!dryRun) syncLockfile()
		return
	}
	for (const change of changes) {
		const prefix = dryRun ? "Would change" : "Wrote"
		console.log(`${prefix} ${change.manifestPath}`)
		if (!dryRun) fs.writeFileSync(change.manifestPath, change.afterContent)
	}
	const verb = dryRun ? "Would update" : "Updated"
	console.log(`\n${verb} ${changes.length} package.json manifests.`)
	if (!dryRun) syncLockfile()
}

// Returns manifests whose versions disagree with the target or one another.
function findDrift<T>(
	items: readonly T[],
	versionOf: (item: T) => string,
	target: string | undefined,
): T[] {
	if (target !== undefined) {
		return items.filter((item) => versionOf(item) !== target)
	}
	return new Set(items.map(versionOf)).size > 1 ? [...items] : []
}

function runVerify(target: string | undefined): void {
	if (target !== undefined && !VERSION_RE.test(target)) {
		console.error(
			`Invalid version "${target}". Expected MAJOR.MINOR.PATCH (e.g., 0.2.0).`,
		)
		process.exitCode = 1
		return
	}
	const all = collectNpmPackages()
	const offenders = findDrift(all, (pkg) => pkg.version, target)
	if (offenders.length > 0) {
		const label = target ?? "matching the workspace"
		console.error(`Version drift detected (expected: ${label}):`)
		for (const o of offenders) {
			console.error(`  ${o.version.padEnd(16)} ${o.manifestPath}`)
		}
		process.exitCode = 1
		return
	}
	const v = target ?? all[0]?.version ?? UNVERSIONED
	console.log(`All ${all.length} manifests at version ${v}.`)
}

type BumpKind = "patch" | "minor" | "major"

function isBumpKind(value: string): value is BumpKind {
	return value === "patch" || value === "minor" || value === "major"
}

// The base for a patch/minor/major increment: every versioned manifest must
// already agree (the invariant `verify` enforces), otherwise there is no
// single current version to increment from.
function currentWorkspaceVersion(): string {
	const all = collectNpmPackages().filter((pkg) => pkg.version !== UNVERSIONED)
	const versions = [...new Set(all.map((pkg) => pkg.version))]
	const current = versions[0]
	if (versions.length !== 1 || current === undefined) {
		throw new Error(
			`Cannot derive the next version: manifests disagree (${versions.join(", ") || "none found"}). ` +
				"Run `node --import tsx scripts/release.ts verify` and fix the drift first.",
		)
	}
	return current
}

function nextVersion(current: string, kind: BumpKind): string {
	const match = current.match(/^(\d+)\.(\d+)\.(\d+)$/)
	if (
		!match ||
		match[1] === undefined ||
		match[2] === undefined ||
		match[3] === undefined
	) {
		throw new Error(`Workspace version "${current}" is not MAJOR.MINOR.PATCH.`)
	}
	const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
	switch (kind) {
		case "major":
			return `${major + 1}.0.0`
		case "minor":
			return `${major}.${minor + 1}.0`
		case "patch":
			return `${major}.${minor}.${patch + 1}`
	}
}

// `patch`/`minor`/`major` resolve to a concrete version up front so every
// later step (and the operator) sees the real number.
function resolveVersionArg(arg: string): string {
	if (!isBumpKind(arg)) return arg
	const current = currentWorkspaceVersion()
	const resolved = nextVersion(current, arg)
	console.log(`${arg}: ${current} -> ${resolved}`)
	return resolved
}

function run(command: string, args: string[]): void {
	const result = spawnSync(command, args, { stdio: "inherit" })
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}.`)
	}
}

function capture(command: string, args: string[]): string {
	const result = spawnSync(command, args, { encoding: "utf8" })
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} exited with status ${result.status}.\n${result.stderr}`,
		)
	}
	return result.stdout.trim()
}

function step(title: string): void {
	console.log(`\n==> ${title}`)
}

function assertCleanTree(context: string): void {
	const dirty = capture("git", ["status", "--porcelain"])
	if (dirty.length > 0) {
		throw new Error(`${context}:\n${dirty}`)
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

// A workflow run registers on GitHub a few seconds after its triggering push
// (for a tag-push event the run's branch field carries the tag name), so
// finding it is a short bounded poll.
async function findWorkflowRunId(workflow: string, filter: string[]): Promise<string> {
	for (let attempt = 0; attempt < 24; attempt++) {
		const runId = capture("gh", [
			"run",
			"list",
			`--workflow=${workflow}`,
			...filter,
			"--json",
			"databaseId",
			"--jq",
			".[0].databaseId",
		])
		if (runId.length > 0) return runId
		await sleep(5_000)
	}
	throw new Error(`No ${workflow} run appeared (${filter.join(" ")}) within 2 minutes.`)
}

// Every CI wait in the cut is this one shape: find the run, follow it live,
// and let --exit-status turn a red (or cancelled) run into a non-zero exit.
async function watchWorkflowRun(workflow: string, filter: string[]): Promise<void> {
	run("gh", ["run", "watch", await findWorkflowRunId(workflow, filter), "--exit-status"])
}

// The cut's rungs in execution order; --until names the one to stop after.
const CUT_STAGES = [
	"1-bump",
	"2-commit",
	"3-push",
	"4-check",
	"5-push-tag",
	"6-release",
] as const
type CutStage = (typeof CUT_STAGES)[number]

function isCutStage(value: string): value is CutStage {
	return (CUT_STAGES as readonly string[]).includes(value)
}

type CutTarget = { until: CutStage }

async function runCut(version: string, target: CutTarget): Promise<void> {
	const tag = `v${version}`

	step("preflight: on main, clean, fast-forwarded, tag free")
	const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"])
	if (branch !== "main") {
		throw new Error(`Releases are cut from main; currently on '${branch}'.`)
	}
	assertCleanTree("Working tree must be clean before a cut")
	run("git", ["pull", "--ff-only"])
	if (capture("git", ["ls-remote", "--tags", "origin", tag]).length > 0) {
		throw new Error(`Tag ${tag} already exists on origin.`)
	}
	const localTag = spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`])
	if (localTag.status === 0) {
		throw new Error(
			`Tag ${tag} already exists locally (a previous cut died before pushing it?). ` +
				`Inspect it, then \`git tag -d ${tag}\` to re-cut or push it manually.`,
		)
	}

	step(`1-bump: every manifest to ${version}`)
	runBump(version, false)
	if (target.until === "1-bump") {
		console.log(
			"\nStopped after 1-bump: the tree is bumped but uncommitted. Inspect with `git diff`; " +
				"commit or revert before re-running (preflight requires a clean tree).",
		)
		return
	}

	step(`2-commit: "chore: release ${version}"`)
	if (capture("git", ["status", "--porcelain"]).length > 0) {
		run("git", ["add", "-A"])
		run("gitc", [])
	} else {
		console.log("Nothing to commit — the tree was already at this version.")
	}
	if (target.until === "2-commit") {
		console.log(
			"\nStopped after 2-commit: the release commit exists locally, unpushed. " +
				"Re-run to continue — completed rungs no-op.",
		)
		return
	}

	step("3-push: main")
	run("git", ["push"])
	if (target.until === "3-push") {
		console.log(
			"\nStopped after 3-push: main is pushed; check.yml is running. " +
				"Re-run to gate and tag.",
		)
		return
	}

	step("4-check: require check.yml to pass before tagging")
	const sha = capture("git", ["rev-parse", "HEAD"])
	await watchWorkflowRun("check.yml", ["--commit", sha, "--event", "push"])
	if (target.until === "4-check") {
		console.log(
			`\nStopped after 4-check: check.yml is green for ${sha}; no tag pushed. ` +
				"Re-run to check again and tag.",
		)
		return
	}

	step(`5-push-tag: ${tag}`)
	run("git", ["tag", tag])
	run("git", ["push", "origin", tag])
	if (target.until === "5-push-tag") {
		console.log(
			`\n${tag} pushed; release.yml started. Follow it with:\n` +
				`  gh run list --workflow=release.yml --branch ${tag}`,
		)
		return
	}

	step(`6-release: follow release.yml for ${tag}`)
	await watchWorkflowRun("release.yml", ["--branch", tag, "--event", "push"])
}

const USAGE =
	"Usage:\n" +
	"  node --import tsx scripts/release.ts audit\n" +
	"  node --import tsx scripts/release.ts verify [<version>]\n" +
	"  node --import tsx scripts/release.ts publish-list npm\n" +
	"  node --import tsx scripts/release.ts bump <version|patch|minor|major> [--dry-run]\n" +
	"  node --import tsx scripts/release.ts <version|patch|minor|major> [--until=<rung>] [--dry-run]\n" +
	"    rungs: 1-bump, 2-commit, 3-push, 4-check, 5-push-tag (default), 6-release\n" +
	"    4-check watches check.yml; 5-push-tag triggers release.yml;\n" +
	"    6-release also watches release.yml. Main and version-tag pushes trigger the workflows."

function resolveCutTarget(until: string | undefined): CutTarget {
	const stage = until ?? "5-push-tag"
	if (!isCutStage(stage)) {
		throw new Error(
			`Unknown --until rung "${until}". Rungs: ${CUT_STAGES.join(", ")}.\n${USAGE}`,
		)
	}
	return { until: stage }
}

async function main(): Promise<void> {
	const args = process.argv.slice(2)
	const first = args[0]
	if (first === "audit") {
		runAudit()
		return
	}
	if (first === "verify") {
		runVerify(args[1])
		return
	}
	if (first === "publish-list") {
		runPublishList(args[1])
		return
	}
	if (
		first === "bump" &&
		args[1] !== undefined &&
		(VERSION_RE.test(args[1]) || isBumpKind(args[1]))
	) {
		runBump(resolveVersionArg(args[1]), args.includes("--dry-run"))
		return
	}
	if (first !== undefined && (VERSION_RE.test(first) || isBumpKind(first))) {
		const version = resolveVersionArg(first)
		const flags = args.slice(1)
		const dryRun = flags.includes("--dry-run")
		const until = flags
			.find((flag) => flag.startsWith("--until="))
			?.slice("--until=".length)
		// Reject anything unrecognized so a typo (e.g. `--until deploy` without
		// the `=`) fails loud instead of silently cutting without it.
		const unknown = flags.filter(
			(flag) => flag !== "--dry-run" && !flag.startsWith("--until="),
		)
		if (unknown.length > 0) {
			throw new Error(`Unrecognized arguments: ${unknown.join(" ")}\n${USAGE}`)
		}
		if (dryRun) {
			if (until !== undefined) {
				throw new Error("--dry-run only previews the bump; drop --until.")
			}
			runBump(version, true)
			return
		}
		await runCut(version, resolveCutTarget(until))
		return
	}
	console.error(USAGE)
	process.exitCode = 1
}

try {
	await main()
} catch (error: unknown) {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
}
