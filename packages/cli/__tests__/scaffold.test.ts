import { Buffer } from "node:buffer"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { declarationSchema } from "@usecontextlayer/shared/declaration"
import { execa } from "execa"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createSlateCheckout } from "@/scaffold"

const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url))
const templates = fileURLToPath(new URL("../templates/", import.meta.url))
let directory: string

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "ctx-scaffold-"))
	const gitconfig = join(directory, "gitconfig")
	await writeFile(
		gitconfig,
		"[user]\n\tname = Slate Author\n\temail = author@example.com\n[commit]\n\tgpgsign = false\n",
	)
	vi.stubEnv("GIT_CONFIG_GLOBAL", gitconfig)
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1")
	vi.stubEnv("GIT_CONFIG_COUNT", "0")
})

afterEach(async () => {
	vi.unstubAllEnvs()
	await rm(directory, { force: true, recursive: true })
})

test("an empty slate starts on main with only its short orientation committed", async () => {
	const checkout = join(directory, "slate")
	await createSlateCheckout(checkout, [])
	const git = (args: string[]) => execa("git", args, { cwd: checkout })
	expect((await readdir(checkout)).sort()).toEqual([".git", "AGENTS.md"])
	expect((await git(["branch", "--show-current"])).stdout).toBe("main")
	expect((await git(["ls-tree", "--name-only", "HEAD"])).stdout).toBe("AGENTS.md")
	expect((await git(["status", "--porcelain"])).stdout).toBe("")
	const orientation = await readFile(join(checkout, "AGENTS.md"), "utf8")
	expect(orientation).toContain("https://docs.usecontextlayer.com")
	expect(orientation.split("\n").length).toBeLessThan(10)
})

test("static and agent source combine without a package manifest", async () => {
	const checkout = join(directory, "slate")
	await createSlateCheckout(checkout, ["public", "agents"])
	expect((await readdir(checkout)).sort()).toEqual([
		".git",
		"AGENTS.md",
		"agents",
		"public",
	])
	expect(await readFile(join(checkout, "public/index.html"), "utf8")).toContain(
		"<body></body>",
	)
	expect(
		declarationSchema.parse(
			JSON.parse(await readFile(join(checkout, "agents/agent/slate.json"), "utf8")),
		),
	).toEqual({ connections: {}, databases: {}, secrets: {} })
	expect((await execa("git", ["status", "--porcelain"], { cwd: checkout })).stdout).toBe(
		"",
	)
})

test.each(["app", "public", "agents", "mcp"])(
	"ctx scaffold %s copies the complete canonical source",
	async (kind) => {
		const checkout = join(directory, "slate")
		await mkdir(checkout)
		const { stdout } = await execa(process.execPath, [cli, "scaffold", kind], {
			cwd: checkout,
		})
		expect(stdout).toContain(`Added ${kind} source.`)
		const source = join(templates, kind)
		const entries = await readdir(source, { recursive: true, withFileTypes: true })
		const sourceFiles = entries
			.filter((entry) => entry.isFile())
			.map((entry) => join(entry.parentPath, entry.name).slice(source.length + 1))
			.sort()
		const copiedEntries = await readdir(checkout, {
			recursive: true,
			withFileTypes: true,
		})
		expect(
			copiedEntries
				.filter((entry) => entry.isFile())
				.map((entry) => join(entry.parentPath, entry.name).slice(checkout.length + 1))
				.sort(),
		).toEqual(sourceFiles)
		for (const path of sourceFiles)
			expect(await readFile(join(checkout, path))).toEqual(
				await readFile(join(source, path)),
			)
		if (kind === "app") {
			expect(sourceFiles).toEqual(
				expect.arrayContaining([
					"app/slate.json",
					"app/AGENTS.md",
					"app/routes/home.tsx",
					"databases/notes/migrations/001_create_notes.ts",
					"databases/notes/types.ts",
				]),
			)
			expect(sourceFiles).not.toContain("public/slate.json")
		}
		if (kind === "mcp") {
			expect(sourceFiles.some((path) => path.startsWith("app/"))).toBe(false)
			expect(sourceFiles).not.toContain("workers/local-resources/wrangler.jsonc")
			expect(await readFile(join(checkout, "mcp/tool/index.ts"), "utf8")).toContain(
				"export function handler(_args: z.infer<typeof tool.inputSchema>) {}",
			)
		}
		if (kind === "app" || kind === "mcp") expect(stdout).toContain("pnpm install")
	},
)

test("a conflict writes none of the app proposal and prints every path and complete content", async () => {
	const checkout = join(directory, "slate")
	await mkdir(checkout)
	await writeFile(join(checkout, "package.json"), "existing private source")
	await writeFile(join(checkout, ".env"), "UNRELATED_SECRET=must-not-be-printed")
	const { stdout, exitCode } = await execa(process.execPath, [cli, "scaffold", "app"], {
		cwd: checkout,
		reject: false,
	})
	expect(exitCode).toBe(1)
	expect(stdout).toContain("No app files were written")
	expect((await readdir(checkout)).sort()).toEqual([".env", "package.json"])
	expect(await readFile(join(checkout, "package.json"), "utf8")).toBe(
		"existing private source",
	)
	expect(stdout).not.toContain("existing private source")
	expect(stdout).not.toContain("must-not-be-printed")
	const source = join(templates, "app")
	for (const entry of await readdir(source, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue
		const path = join(entry.parentPath, entry.name).slice(source.length + 1)
		const content = Buffer.from(await readFile(join(source, path)))
		if (path === "public/favicon.ico") {
			expect(stdout).toContain(`--- ${path} (base64) ---\n${content.toString("base64")}`)
		} else expect(stdout).toContain(`--- ${path} ---\n${content.toString("utf8")}`)
	}
})

test("an existing file at a proposed directory is a conflict with no partial write", async () => {
	const checkout = join(directory, "slate")
	await mkdir(checkout)
	await writeFile(join(checkout, "agents"), "authored source")
	const { stdout, exitCode } = await execa(
		process.execPath,
		[cli, "scaffold", "agents"],
		{ cwd: checkout, reject: false },
	)
	expect(exitCode).toBe(1)
	expect(stdout).toContain("agents/agent/instructions.md")
	expect(stdout).toContain("agents/agent/slate.json")
	expect(await readdir(checkout)).toEqual(["agents"])
})

test("help exposes four independent init flags and one scaffold choice", async () => {
	const init = await execa(process.execPath, [cli, "init", "--help"])
	for (const kind of ["app", "public", "agents", "mcp"])
		expect(init.stdout).toContain(`--scaffold-${kind}`)
	expect(init.stdout).toContain("Without flags")
	const scaffold = await execa(process.execPath, [cli, "scaffold", "--help"])
	expect(scaffold.stdout).toContain("<kind>")
	expect(scaffold.stdout).toContain('"app", "public", "agents", "mcp"')
	const invalid = await execa(process.execPath, [cli, "scaffold", "app,agents"], {
		reject: false,
	})
	expect(invalid.exitCode).toBe(1)
})
