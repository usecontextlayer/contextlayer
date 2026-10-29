import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { test as base, expect } from "vitest"
import { prepareSlateArtifactsCommand } from "@/preparation"

const execFile = promisify(execFileCallback)
const test = base.extend<{ directory: string }>({
	// biome-ignore lint/correctness/noEmptyPattern: Vitest discovers fixture dependencies by destructuring.
	directory: async ({}, use) => {
		const directory = await mkdtemp(join(tmpdir(), "slate-preparation-"))
		try {
			await use(directory)
		} finally {
			await rm(directory, { force: true, recursive: true })
		}
	},
})

test("prepares raw and hidden public assets without a package manifest", async ({
	directory,
}) => {
	await mkdir(join(directory, "public/.well-known"), { recursive: true })
	const bytes = new Uint8Array([0, 255, 128, 13, 10])
	await writeFile(join(directory, "public/image.bin"), bytes)
	await writeFile(join(directory, "public/.well-known/proof"), "hidden asset")
	await execFile("sh", ["-c", prepareSlateArtifactsCommand], { cwd: directory })
	expect(await readFile(join(directory, "build/client/image.bin"))).toEqual(
		Buffer.from(bytes),
	)
	expect(await readFile(join(directory, "build/client/.well-known/proof"), "utf8")).toBe(
		"hidden asset",
	)
	expect(await readdir(join(directory, "build"))).toEqual(["client"])
})

test.for(["empty", "agent-only"])(
	"prepares an empty assets directory for %s source without a package manifest",
	async (source, { directory }) => {
		if (source === "agent-only") {
			await mkdir(join(directory, "agents/assistant"), { recursive: true })
			await writeFile(
				join(directory, "agents/assistant/instructions.md"),
				"Assist the user.",
			)
			await writeFile(join(directory, "agents/assistant/slate.json"), "{}")
		}
		await execFile("sh", ["-c", prepareSlateArtifactsCommand], { cwd: directory })
		expect(await readdir(join(directory, "build"))).toEqual(["client"])
		expect(await readdir(join(directory, "build/client"))).toEqual([])
	},
)

test("installs a package used without an authored build script", async ({
	directory,
}) => {
	await writeFile(
		join(directory, "package.json"),
		JSON.stringify({
			name: "agent-dependencies",
			private: true,
			scripts: {
				postinstall: 'node -e \'require("node:fs").writeFileSync("installed", "ready")\'',
			},
		}),
	)
	await execFile("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], {
		cwd: directory,
	})
	await execFile("sh", ["-c", prepareSlateArtifactsCommand], { cwd: directory })
	expect(await readFile(join(directory, "installed"), "utf8")).toBe("ready")
	expect(await readdir(join(directory, "build/client"))).toEqual([])
}, 30_000)

test("runs the authored build instead of preparing public source", async ({
	directory,
}) => {
	await mkdir(join(directory, "public"))
	await writeFile(join(directory, "public/not-built.txt"), "source")
	await writeFile(
		join(directory, "package.json"),
		JSON.stringify({
			name: "authored-build",
			private: true,
			scripts: {
				build:
					'node -e \'const fs = require("node:fs"); fs.mkdirSync("build/server", { recursive: true }); fs.mkdirSync("build/client"); fs.writeFileSync("build/server/index.js", "export default {}");\'',
			},
		}),
	)
	await execFile("pnpm", ["install", "--lockfile-only"], { cwd: directory })
	await execFile("sh", ["-c", prepareSlateArtifactsCommand], { cwd: directory })
	expect(await readFile(join(directory, "build/server/index.js"), "utf8")).toBe(
		"export default {}",
	)
	expect(await readdir(join(directory, "build/client"))).toEqual([])
}, 30_000)

test("surfaces an invalid package manifest", async ({ directory }) => {
	await writeFile(join(directory, "package.json"), "{")
	await expect(
		execFile("sh", ["-c", prepareSlateArtifactsCommand], { cwd: directory }),
	).rejects.toThrow()
	await expect(readdir(join(directory, "build"))).rejects.toMatchObject({
		code: "ENOENT",
	})
})

test("surfaces an authored build failure", async ({ directory }) => {
	await writeFile(
		join(directory, "package.json"),
		JSON.stringify({
			name: "failed-build",
			private: true,
			scripts: { build: 'node -e "process.exit(23)"' },
		}),
	)
	await execFile("pnpm", ["install", "--lockfile-only"], { cwd: directory })
	await expect(
		execFile("sh", ["-c", prepareSlateArtifactsCommand], { cwd: directory }),
	).rejects.toThrow()
	await expect(readdir(join(directory, "build"))).rejects.toMatchObject({
		code: "ENOENT",
	})
}, 30_000)
