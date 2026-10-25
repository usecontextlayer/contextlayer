import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { test as base, expect } from "vitest"
import { slateDeploymentConfig } from "@/deployment"

const execFile = promisify(execFileCallback)
const prepare = join(import.meta.dirname, "prepare-artifact.py")
const wrangler = join(import.meta.dirname, "node_modules/.bin/wrangler")
const test = base.extend<{ directory: string }>({
	// biome-ignore lint/correctness/noEmptyPattern: Vitest discovers fixture dependencies by destructuring.
	directory: async ({}, use) => {
		const directory = await mkdtemp(join(tmpdir(), "slate-artifact-"))
		try {
			await use(directory)
		} finally {
			await rm(directory, { force: true, recursive: true })
		}
	},
})

test("prepares compiled modules and assets for trusted Wrangler", async ({
	directory,
}) => {
	const source = join(directory, "author")
	const output = join(directory, "deploy")
	const archive = join(directory, "build.tar.gz")
	await mkdir(join(source, "build/server/assets"), { recursive: true })
	await mkdir(join(source, "build/client"), { recursive: true })
	await writeFile(
		join(source, "build/server/index.js"),
		'import { value } from "./assets/chunk.js"; throw new Error("AUTHOR_MODULE_EXECUTED"); export default { fetch() { return new Response(value) } };',
	)
	await writeFile(
		join(source, "build/server/assets/chunk.js"),
		'export const value = "slate";',
	)
	await writeFile(join(source, "build/client/index.html"), "<p>slate assets</p>")
	await writeFile(
		join(source, "build/server/wrangler.json"),
		JSON.stringify({
			build: { command: "echo AUTHOR_BUILD_EXECUTED; exit 1" },
			name: "author-selected-name",
			vars: { DANGEROUS: "author binding" },
		}),
	)
	await writeFile(join(source, ".env"), "NODE_OPTIONS=--import ./author.js")
	await writeFile(join(source, "build/server/package.json"), '{"type":"commonjs"}')
	await execFile("tar", ["-czf", archive, "-C", source, "."], {
		env: { ...process.env, COPYFILE_DISABLE: "1" },
	})
	await execFile("python3", ["-I", prepare, archive, output])
	await writeFile(
		join(output, "wrangler.json"),
		JSON.stringify(slateDeploymentConfig("trusted-slate")),
	)

	expect(await readdir(output)).toEqual(["client", "server", "wrangler.json"])
	expect(await readdir(join(output, "server"))).toEqual(["assets", "index.js"])

	await execFile(
		wrangler,
		[
			"deploy",
			"--config",
			"wrangler.json",
			"--no-bundle",
			"--dry-run",
			"--outfile",
			join(directory, "worker.bundle"),
			"--dispatch-namespace",
			"test",
		],
		{
			cwd: output,
			env: {
				CI: "true",
				PATH: process.env.PATH,
				WRANGLER_LOG_PATH: join(directory, "wrangler.log"),
				WRANGLER_SEND_METRICS: "false",
			},
		},
	)
	const bundle = await readFile(join(directory, "worker.bundle"))
	const boundary = bundle.toString().split("\r\n", 1)[0].slice(2)
	const upload = await new Response(new Uint8Array(bundle), {
		headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
	}).formData()
	const metadata = JSON.parse(String(upload.get("metadata")))
	expect(metadata.bindings).toEqual([{ name: "ASSETS", type: "assets" }])
	expect(upload.has("assets/chunk.js")).toBe(true)
	expect(await readFile(join(output, "client/index.html"), "utf8")).toBe(
		"<p>slate assets</p>",
	)
}, 30_000)

for (const kind of ["traversal", "symlink", "hardlink"]) {
	test(`rejects archive ${kind} before publication`, async ({ directory }) => {
		const archive = join(directory, "hostile.tar")
		const output = join(directory, "deploy")
		const sentinel = join(directory, "platform-tool")
		await writeFile(sentinel, "platform-owned")
		await execFile("python3", [
			"-I",
			"-c",
			`
import io, sys, tarfile
archive, target, kind = sys.argv[1:]
member = tarfile.TarInfo("build/server/index.js")
if kind == "traversal":
    member.name = "../" * 20 + target.lstrip("/")
    member.size = 5
else:
    member.type = tarfile.SYMTYPE if kind == "symlink" else tarfile.LNKTYPE
    member.linkname = target
with tarfile.open(archive, "w") as output:
    output.addfile(member, io.BytesIO(b"owned"))
`,
			archive,
			sentinel,
			kind,
		])
		await expect(execFile("python3", ["-I", prepare, archive, output])).rejects.toThrow()
		expect(await readFile(sentinel, "utf8")).toBe("platform-owned")
		await expect(readdir(output)).rejects.toThrow()
	})
}
