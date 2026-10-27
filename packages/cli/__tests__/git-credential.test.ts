import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { execa } from "execa"
import { afterEach, expect, test, vi } from "vitest"
import { configureGit } from "@/git-credential"

const directories: string[] = []
const servers: Server[] = []
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url))
const cwd = fileURLToPath(new URL("..", import.meta.url))
const invocation = [
	process.execPath,
	fileURLToPath(import.meta.resolve("tsx/cli")),
	"--tsconfig",
	fileURLToPath(new URL("../tsconfig.json", import.meta.url)),
	cli,
]
	.map((argument) => `'${argument.replaceAll("'", "'\\''")}'`)
	.join(" ")

afterEach(async () => {
	vi.unstubAllEnvs()
	await Promise.all([
		...servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.closeAllConnections()
					server.close((error) => (error ? reject(error) : resolve()))
				}),
		),
		...directories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	])
})

test("one registration serves every slate with the latest registered login", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ctx-git author's login-"))
	directories.push(directory)
	vi.stubEnv("GIT_CONFIG_GLOBAL", join(directory, "gitconfig"))
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1")
	vi.stubEnv("GIT_CONFIG_COUNT", "0")

	const server = createServer((_request, response) => {
		response.setHeader("content-type", "application/json")
		response.end(JSON.stringify({ id: "author" }))
	})
	servers.push(server)
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	const address = server.address()
	if (address === null || typeof address === "string") throw new Error("No HTTP address")
	const settings = {
		CTX_AUTH_CLIENT_ID: "author's CLI",
		CTX_AUTH_ISSUER: `http://127.0.0.1:${address.port}/api/auth`,
		CTX_CONFIG_DIR: join(directory, "first"),
		CTX_PLATFORM_URL: "https://platform.example.com",
	}
	for (const account of ["first", "second"]) {
		settings.CTX_CONFIG_DIR = join(directory, account)
		await mkdir(settings.CTX_CONFIG_DIR)
		await writeFile(
			join(settings.CTX_CONFIG_DIR, "auth.json"),
			JSON.stringify({
				accessToken: `${account}-access-token`,
				clientId: settings.CTX_AUTH_CLIENT_ID,
				expiresAt: Date.now() + 60_000,
				issuer: settings.CTX_AUTH_ISSUER,
			}),
		)
		await configureGit(settings, invocation)
	}
	const registration = await execa("git", [
		"config",
		"--global",
		"--get-all",
		"credential.https://platform.example.com/git.helper",
	])
	expect(registration.stdout.split("\n")).toEqual([
		"",
		expect.stringContaining(invocation),
	])
	for (const slate of ["first-slate", "second-slate"]) {
		const { stdout } = await execa("git", ["credential", "fill"], {
			cwd,
			env: {
				CTX_AUTH_CLIENT_ID: "ambient-client",
				CTX_AUTH_ISSUER: "http://127.0.0.1:1/api/auth",
				CTX_CLI_COMMAND: "ambient-helper-must-not-leak",
				CTX_CONFIG_DIR: join(directory, "ambient"),
				CTX_PLATFORM_URL: "https://ambient.example.com",
				GIT_TERMINAL_PROMPT: "0",
			},
			input: `protocol=https\nhost=platform.example.com\npath=git/${slate}\ncapability[]=authtype\n\n`,
		})
		expect(stdout).toContain("authtype=Bearer")
		expect(stdout).toContain("credential=second-access-token")
	}
	await rm(join(settings.CTX_CONFIG_DIR, "auth.json"))
	const { exitCode, stderr } = await execa("git", ["credential", "fill"], {
		cwd,
		env: {
			CTX_CLI_COMMAND: "ambient-helper-must-not-leak",
			GIT_TERMINAL_PROMPT: "0",
		},
		input:
			"protocol=https\nhost=platform.example.com\npath=git/first-slate\ncapability[]=authtype\n\n",
		reject: false,
	})
	expect(exitCode).toBe(128)
	expect(stderr).toContain("Not signed in.")
	expect(stderr).toContain("CTX_CLI_COMMAND=")
	expect(stderr).not.toContain("ambient-helper-must-not-leak")
})

test.each(["capability", "store", "erase"])(
	"Git helper %s does not require a saved login",
	async (operation) => {
		const directory = await mkdtemp(join(tmpdir(), "ctx-git-no-login-"))
		directories.push(directory)
		const { stdout } = await execa(
			process.execPath,
			["--import", "tsx", cli, "git-credential", operation],
			{ cwd, env: { CTX_CONFIG_DIR: directory } },
		)
		expect(stdout).toBe(
			operation === "capability" ? "version 0\ncapability authtype" : "",
		)
	},
)
