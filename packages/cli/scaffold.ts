import { Buffer } from "node:buffer"
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execa } from "execa"
import { z } from "zod"

export const scaffoldKindSchema = z.enum(["app", "public", "agents", "mcp"])
export type ScaffoldKind = z.infer<typeof scaffoldKindSchema>

export const initOptionsSchema = z.object({
	org: z.string().min(1).optional(),
	scaffoldAgents: z.boolean().default(false),
	scaffoldApp: z.boolean().default(false),
	scaffoldMcp: z.boolean().default(false),
	scaffoldPublic: z.boolean().default(false),
})

const orientation = `# ContextLayer slate

This Git repository is your slate's source. Add and edit only the parts you need: app/, public/, agents/, and mcp/ are independent. App-specific guidance lives in app/AGENTS.md when present.

Read [ContextLayer documentation](https://docs.usecontextlayer.com) before authoring declarations, resources, or deployment configuration. Use ctx --help for local tooling and scaffolding. Commit source changes and push main to deploy.
`

async function proposedFiles(directory: string) {
	const entries = await readdir(directory, { recursive: true, withFileTypes: true })
	return Promise.all(
		entries
			.filter((entry) => entry.isFile())
			.map(async (entry) => {
				const source = join(entry.parentPath, entry.name)
				return { content: await readFile(source), path: relative(directory, source) }
			}),
	)
}

async function existingEntry(path: string) {
	return lstat(path).catch((error: unknown) => {
		if (
			error instanceof Error &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ENOTDIR")
		)
			return undefined
		throw error
	})
}

export async function scaffoldSlate(kind: ScaffoldKind, directory: string) {
	const files = await proposedFiles(
		fileURLToPath(new URL(`./templates/${kind}/`, import.meta.url)),
	)
	const root = resolve(directory)
	let conflict = false
	for (const file of files) {
		const destination = join(root, file.path)
		if (await existingEntry(destination)) conflict = true
		let parent = dirname(destination)
		while (parent !== root) {
			const entry = await existingEntry(parent)
			if (entry && !entry.isDirectory()) conflict = true
			parent = dirname(parent)
		}
	}
	if (conflict) {
		console.log(
			`The ${kind} scaffold conflicts with existing source. No ${kind} files were written. Integrate this complete proposal with your authoring agent:`,
		)
		for (const file of files) {
			const content = Buffer.from(file.content)
			const text = content.toString("utf8")
			const binary = !Buffer.from(text).equals(content)
			console.log(
				`\n--- ${file.path}${binary ? " (base64)" : ""} ---\n${binary ? content.toString("base64") : text}`,
			)
		}
		return false
	}
	for (const file of files) {
		const destination = join(root, file.path)
		await mkdir(dirname(destination), { recursive: true })
		await writeFile(destination, file.content, { flag: "wx" })
	}
	console.log(`Added ${kind} source.`)
	if (kind === "app" || kind === "mcp") {
		console.log(
			"Run pnpm install in the slate root to install dependencies and create or update pnpm-lock.yaml. Commit the lockfile with your source.",
		)
	}
	if (kind === "mcp")
		console.log(
			"Author mcp/tool/index.ts before invoking the tool; its handler is empty.",
		)
	return true
}

export async function createSlateCheckout(directory: string, scaffolds: ScaffoldKind[]) {
	await mkdir(directory)
	await writeFile(join(directory, "AGENTS.md"), orientation)
	await execa("git", ["init", "--initial-branch=main"], {
		cwd: directory,
		stdio: "inherit",
	})
	let dependencies = false
	for (const kind of scaffolds) {
		if (await scaffoldSlate(kind, directory)) {
			dependencies ||= kind === "app" || kind === "mcp"
		}
	}
	if (dependencies) await execa("pnpm", ["install"], { cwd: directory, stdio: "inherit" })
	await execa("git", ["add", "."], { cwd: directory, stdio: "inherit" })
	await execa("git", ["commit", "-m", "Initialize ContextLayer slate"], {
		cwd: directory,
		stdio: "inherit",
	})
	return { dependencies }
}
