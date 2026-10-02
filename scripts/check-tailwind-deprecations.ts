import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import Parser from "tree-sitter"
import TypeScript from "tree-sitter-typescript"

// Only scan source types with a grammar: compiler candidates must occur in strings,
// not prose comments. CSS @apply checking is outside this check's scope.
const SOURCE_PATTERN = "**/*.{ts,tsx}"
const TAILWIND_IMPORT = /@import\s+(?:url\(\s*)?["']tailwindcss(?:\/[^"']*)?["']/
const TAILWIND_INTEGRATIONS = [
	"@tailwindcss/vite",
	"@tailwindcss/postcss",
	"@tailwindcss/cli",
]

// biome-ignore lint/suspicious/noExplicitAny: the grammar packages ship no usable types.
type Grammar = any

const GRAMMAR_BY_EXTENSION = new Map<string, Grammar>([
	[".ts", TypeScript.typescript],
	[".tsx", TypeScript.tsx],
])

// Tailwind marks superseded v3 utilities by keeping their theme keys in a block commented
// `/* Deprecated */`. Reading the block instead of restating it means this check follows
// upstream: a key Tailwind adds or drops changes what we flag without an edit here.
const DEPRECATED_BLOCK = /\/\*\s*Deprecated\s*\*\/\s*@theme[^{]*\{([\s\S]*?)\n\}/
const THEME_KEY = /^\s*(--[a-z0-9-]+)\s*:/gim

type DesignSystem = {
	candidatesToCss: (candidates: string[]) => (string | null)[]
}

type Finding = {
	file: string
	line: number
	candidate: string
	themeKey: string
}

function requireFrom(directory: string): NodeJS.Require {
	return createRequire(path.join(path.resolve(directory), "noop.js"))
}

function readDeprecatedThemeKeys(themeCssPath: string): string[] {
	const themeCss = fs.readFileSync(themeCssPath, "utf8")
	const block = themeCss.match(DEPRECATED_BLOCK)?.[1]
	if (block === undefined) {
		throw new Error(
			`Could not find the '/* Deprecated */' theme block in ${themeCssPath}. Tailwind changed how it marks deprecated theme keys; update this check.`,
		)
	}

	const keys: string[] = []
	for (const match of block.matchAll(THEME_KEY)) {
		const key = match[1]
		if (key !== undefined) {
			keys.push(key)
		}
	}
	if (keys.length === 0) {
		throw new Error(
			`The '/* Deprecated */' theme block in ${themeCssPath} declared no theme keys. Tailwind changed the block's shape; update this check.`,
		)
	}
	return keys
}

// Both oxide and tree-sitter report CHARACTER offsets, so their positions are directly
// comparable. Measured rather than assumed, because the two disagreeing would be silent: a
// finding would land on the wrong line, or be dropped for falling outside a string range,
// only in files containing a multi-byte character ahead of it.
function lineAt(content: string, charIndex: number): number {
	return content.slice(0, charIndex).split("\n").length
}

// Tailwind classes are written inside string literals; oxide does not know that. It extracts
// every identifier-ish token, comments included, so `// blur the boundary so the shadow reads
// softer` yields `blur` and `shadow` — both utilities Tailwind deprecated — and the check
// fails a build over English prose with no class to fix. Which spans are string content is
// exactly what a grammar settles and a token scan cannot. `string_fragment` is the content
// inside quoted strings, template literals, and JSX attribute values alike.
function stringContentRanges(content: string, grammar: Grammar): [number, number][] {
	const parser = new Parser()
	parser.setLanguage(grammar)

	const ranges: [number, number][] = []
	const visit = (node: Parser.SyntaxNode): void => {
		if (node.type === "string_fragment") {
			ranges.push([node.startIndex, node.endIndex])
		}
		for (let index = 0; index < node.childCount; index += 1) {
			const child = node.child(index)
			if (child !== null) {
				visit(child)
			}
		}
	}
	visit(parser.parse(content).rootNode)
	return ranges
}

function findStylesheets(): { packageDir: string; stylesheetPath: string }[] {
	const stylesheets: { packageDir: string; stylesheetPath: string }[] = []
	for (const manifestPath of fs.globSync("packages/*/package.json")) {
		const packageDir = path.resolve(path.dirname(manifestPath))
		for (const file of fs.globSync("**/*.css", {
			cwd: packageDir,
			exclude: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.*/**"],
		})) {
			const stylesheetPath = path.join(packageDir, file)
			const css = fs.readFileSync(stylesheetPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
			if (TAILWIND_IMPORT.test(css)) {
				stylesheets.push({ packageDir, stylesheetPath })
			}
		}
	}
	return stylesheets
}

async function findDeprecations(
	packageDir: string,
	stylesheetPath: string,
): Promise<Finding[]> {
	const manifest: {
		dependencies?: Record<string, string>
		devDependencies?: Record<string, string>
	} = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"))
	const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }
	const integration = TAILWIND_INTEGRATIONS.find((name) => name in dependencies)
	if (integration === undefined) {
		throw new Error(
			`${stylesheetPath}: declare a Tailwind Vite, PostCSS, or CLI integration in the package.`,
		)
	}

	// Resolve the compiler and extractor from the package's own build integration,
	// so its installed Tailwind version and stylesheet imports own the result.
	const requireFromIntegration = createRequire(
		requireFrom(packageDir).resolve(integration),
	)
	const tailwind = await import(requireFromIntegration.resolve("@tailwindcss/node"))
	const { Scanner } = requireFromIntegration("@tailwindcss/oxide")
	const css = fs.readFileSync(stylesheetPath, "utf8")
	const options = { base: path.dirname(stylesheetPath) }

	const full: DesignSystem = await tailwind.__unstable__loadDesignSystem(css, options)

	// One design system per deprecated key, each with that key unset. A candidate that
	// compiles against the full system but not against the system missing key K is, by
	// construction, resolving through K — which both detects and attributes it.
	const deprecatedKeys = readDeprecatedThemeKeys(
		requireFromIntegration.resolve("tailwindcss/theme.css"),
	)
	const withoutKey = new Map<string, DesignSystem>()
	for (const key of deprecatedKeys) {
		withoutKey.set(
			key,
			await tailwind.__unstable__loadDesignSystem(
				`${css}\n@theme {\n\t${key}: initial;\n}\n`,
				options,
			),
		)
	}

	const scanner = new Scanner({
		sources: [{ base: packageDir, negated: false, pattern: SOURCE_PATTERN }],
	})

	// Oxide yields non-class tokens too (`import`, `mergeProps`); compiling against the full
	// design system is what discards them.
	const deprecatedCandidates = new Map<string, string>()
	for (const candidate of new Set<string>(scanner.scan())) {
		if (full.candidatesToCss([candidate])[0] === null) {
			continue
		}
		for (const [key, system] of withoutKey) {
			if (system.candidatesToCss([candidate])[0] === null) {
				deprecatedCandidates.set(candidate, key)
				break
			}
		}
	}

	if (deprecatedCandidates.size === 0) {
		return []
	}

	const findings: Finding[] = []
	// Nothing here filters ignored paths: the scanner's source globs already exclude them.
	for (const file of scanner.files) {
		const extension = path.extname(file)
		const grammar = GRAMMAR_BY_EXTENSION.get(extension)
		if (grammar === undefined) {
			throw new Error(
				`${file}: no grammar for '${extension}'. SOURCE_PATTERN and GRAMMAR_BY_EXTENSION have drifted apart; a candidate here could not be told from prose.`,
			)
		}

		const content = fs.readFileSync(file, "utf8")
		const ranges = stringContentRanges(content, grammar)
		for (const { candidate, position } of scanner.getCandidatesWithPositions({
			content,
			extension: extension.slice(1),
			file,
		})) {
			const themeKey = deprecatedCandidates.get(candidate)
			if (themeKey === undefined) {
				continue
			}
			if (!ranges.some(([start, end]) => position >= start && position < end)) {
				continue
			}
			findings.push({
				candidate,
				file: path.relative(process.cwd(), file),
				line: lineAt(content, position),
				themeKey,
			})
		}
	}
	return findings
}

async function main(): Promise<void> {
	const stylesheets = findStylesheets()
	if (stylesheets.length === 0) {
		console.log("Tailwind deprecation check: no Tailwind stylesheets found in packages/.")
		return
	}

	const findings: Finding[] = []
	for (const { packageDir, stylesheetPath } of stylesheets) {
		findings.push(...(await findDeprecations(packageDir, stylesheetPath)))
	}

	if (findings.length > 0) {
		findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
		console.error("Tailwind deprecation check failed:")
		for (const finding of findings) {
			console.error(
				`- ${finding.file}:${finding.line}: '${finding.candidate}' resolves through '${finding.themeKey}', which Tailwind deprecated. Use a named step instead.`,
			)
		}
		process.exitCode = 1
		return
	}

	console.log(`Tailwind deprecation check passed (${stylesheets.length} stylesheets).`)
}

await main()
