// Prints every comment in the files a changeset touches, by file and line.
//
// It exists because a reviewer walking a diff meets each comment alone, in file order, with
// the rest of the file's prose scrolled off and the other copies of the same ruling several
// packages away. Reading the prose as one listing is what makes a repeat visible at all —
// which no per-comment reading can surface, because every copy passes on its own merits.
//
// It prints. It does not judge, score, or rank: deciding which of two comments argue the
// same ruling is reading work, and the repeats here are paraphrases ("every later capture
// push would be rejected non-fast-forward" against "the loser's `capture()` rejects
// non-fast-forward") that no mechanical comparison finds anyway.
//
// Parsing is tree-sitter because this runs against a DIRTY tree, mid-edit, where files are
// routinely half-written — and tree-sitter recovers from a syntax error instead of giving up
// on the rest of the file. Measured on an 805-line, 241-comment file truncated at four
// points: every comment before the cut recovered, none spurious. It also settles by grammar
// what a hand-written scanner only approximates: `const s = "// not a comment"` is a string.
// The one thing nothing recovers is an unterminated block comment, which parses as an error
// rather than as text.

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import Parser from "tree-sitter"
import TypeScript from "tree-sitter-typescript"

const DEFAULT_RANGE = "origin/main...HEAD"

// biome-ignore lint/suspicious/noExplicitAny: the grammar packages ship no usable types.
type Grammar = any

// `.js` and friends go through the TypeScript grammar deliberately: TS is a superset, so it
// parses them without a separate JavaScript grammar.
const GRAMMAR_BY_EXTENSION = new Map<string, Grammar>([
	[".ts", TypeScript.typescript],
	[".mts", TypeScript.typescript],
	[".cts", TypeScript.typescript],
	[".js", TypeScript.typescript],
	[".mjs", TypeScript.typescript],
	[".cjs", TypeScript.typescript],
	[".tsx", TypeScript.tsx],
	[".jsx", TypeScript.tsx],
])

type Comment = {
	startLine: number
	endLine: number
	text: string
}

function git(args: string[]): string {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
}

function stripMarkers(text: string): string {
	return text
		.split("\n")
		.map((line) =>
			line.replace(/^\s*(?:\/\/+|\/\*+|\*+\/?)?\s?/, "").replace(/\*\/$/, ""),
		)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim()
}

// Consecutive comments are ONE comment. A ruling is argued across four or five lines, and
// splitting it into five entries would bury the argument the listing exists to show.
function extractComments(source: string, grammar: Grammar): Comment[] {
	const parser = new Parser()
	parser.setLanguage(grammar)

	const nodes: Parser.SyntaxNode[] = []
	const visit = (node: Parser.SyntaxNode): void => {
		if (node.type === "comment") nodes.push(node)
		for (let index = 0; index < node.childCount; index += 1) {
			const child = node.child(index)
			if (child !== null) visit(child)
		}
	}
	visit(parser.parse(source).rootNode)
	nodes.sort((a, b) => a.startPosition.row - b.startPosition.row)

	const comments: Comment[] = []
	for (const node of nodes) {
		const startLine = node.startPosition.row + 1
		const endLine = node.endPosition.row + 1
		const text = stripMarkers(node.text)
		const previous = comments.at(-1)
		if (previous !== undefined && startLine <= previous.endLine + 1) {
			previous.endLine = Math.max(previous.endLine, endLine)
			previous.text = `${previous.text} ${text}`.trim()
			continue
		}
		comments.push({ endLine, startLine, text })
	}

	return comments.filter((comment) => comment.text.length > 0)
}

// Every file the range touches, and which of its lines the range ADDED. Comment-ness is
// decided by parsing the whole working-tree file rather than the diff, because a hunk can
// begin inside a block comment and a `+` line alone cannot say whether it is in one.
function collectChange(range: string): Map<string, Set<number>> {
	const addedByFile = new Map<string, Set<number>>()
	let file: string | null = null
	let nextLine = 0

	for (const line of git(["diff", "--no-ext-diff", "--unified=0", range]).split("\n")) {
		if (line.startsWith("+++ b/")) {
			file = line.slice("+++ b/".length)
			addedByFile.set(file, addedByFile.get(file) ?? new Set<number>())
			continue
		}
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
		if (hunk?.[1] !== undefined) {
			nextLine = Number(hunk[1])
			continue
		}
		if (file === null || !line.startsWith("+")) continue
		addedByFile.get(file)?.add(nextLine)
		nextLine += 1
	}

	return addedByFile
}

function printHelp(): void {
	console.log(`extract-comments-from-changeset — every comment in the files a changeset touches.

  node --import tsx ./scripts/extract-comments-from-changeset.ts [<range>]

  <range>   any git range, default ${DEFAULT_RANGE}. Use three dots against a branch
            base: two dots reports the base's own commits as this change's work.

Prints the WHOLE file's prose, not only the added lines, because the copy of a ruling you
need to see is usually the one the diff did not touch. A leading + marks a comment the range
added or rewrote. Consecutive comments print as one entry: a ruling argued over five lines is
one comment.

Parses with tree-sitter (TypeScript/TSX/JavaScript/JSX), so a half-written
file mid-edit still yields its prose and a "// ..." inside a string literal is not mistaken
for a comment.`)
}

function main(): void {
	const [firstArgument] = process.argv.slice(2)
	if (firstArgument === "--help" || firstArgument === "-h") {
		printHelp()
		return
	}
	const range = firstArgument ?? DEFAULT_RANGE

	const change = collectChange(range)
	if (change.size === 0) {
		console.error(`No files changed in ${range}. Nothing to extract.`)
		process.exitCode = 1
		return
	}

	let files = 0
	let total = 0
	const sections: string[] = []
	for (const [file, addedLines] of [...change].sort(([a], [b]) => a.localeCompare(b))) {
		const grammar = GRAMMAR_BY_EXTENSION.get(path.extname(file))
		if (grammar === undefined || !fs.existsSync(file)) continue
		const comments = extractComments(fs.readFileSync(file, "utf8"), grammar)
		if (comments.length === 0) continue

		files += 1
		total += comments.length
		const lines = [`\n## ${file}`]
		for (const comment of comments) {
			const span =
				comment.endLine > comment.startLine
					? `${comment.startLine}-${comment.endLine}`
					: `${comment.startLine}`
			let touched = false
			for (let line = comment.startLine; line <= comment.endLine; line += 1) {
				if (addedLines.has(line)) touched = true
			}
			lines.push(`\n[${span}]${touched ? " +" : ""}\n${comment.text}`)
		}
		sections.push(lines.join("\n"))
	}

	console.log(`# COMMENTS — ${range}`)
	console.log(
		`${total} comments across ${files} files; + marks one the range added or rewrote`,
	)
	console.log(sections.join("\n"))
}

main()
