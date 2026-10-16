import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { execa } from "execa"
import { afterEach, expect, test, vi } from "vitest"
import { type AuthEnv, getAccessToken } from "@/auth"

const directories: string[] = []

afterEach(async () => {
	vi.unstubAllEnvs()
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	)
})

test.each([
	{ configured: undefined, expected: join(homedir(), ".contextlayer") },
	{
		configured: join(tmpdir(), "ctx-selected"),
		expected: join(tmpdir(), "ctx-selected"),
	},
])(
	"selects the credential directory from CLI settings ($configured)",
	async ({ configured, expected }) => {
		vi.stubEnv("CTX_CONFIG_DIR", configured)
		vi.resetModules()
		const { env } = await import("@/env")
		expect(env.CTX_CONFIG_DIR).toBe(expected)
	},
)

async function savedLogin(accessToken: string): Promise<AuthEnv> {
	const directory = await mkdtemp(join(tmpdir(), "ctx-auth account's login-"))
	directories.push(directory)
	const settings = {
		CTX_AUTH_CLIENT_ID: "cli-client",
		CTX_AUTH_ISSUER: "https://auth.example.com/api/auth",
		CTX_CONFIG_DIR: directory,
	}
	await writeFile(
		join(directory, "auth.json"),
		JSON.stringify({
			accessToken,
			clientId: settings.CTX_AUTH_CLIENT_ID,
			expiresAt: Date.now() + 60_000,
			issuer: settings.CTX_AUTH_ISSUER,
		}),
	)
	return settings
}

test("concurrent callers use their selected saved logins on the same server", async () => {
	const user = await savedLogin("user-access-token")
	const komal = await savedLogin("komal-access-token")
	const userContents = await readFile(join(user.CTX_CONFIG_DIR, "auth.json"), "utf8")
	const komalContents = await readFile(join(komal.CTX_CONFIG_DIR, "auth.json"), "utf8")

	expect(await Promise.all([getAccessToken(user), getAccessToken(komal)])).toEqual([
		"user-access-token",
		"komal-access-token",
	])
	expect(await getAccessToken(user)).toBe("user-access-token")
	expect(await readFile(join(user.CTX_CONFIG_DIR, "auth.json"), "utf8")).toBe(
		userContents,
	)
	expect(await readFile(join(komal.CTX_CONFIG_DIR, "auth.json"), "utf8")).toBe(
		komalContents,
	)
})

async function expectLoginCommand(stderr: string, settings: Record<string, string>) {
	const [, command] = stderr.split("Run: ")
	expect(command?.trim()).toMatch(/ npx @usecontextlayer\/cli login$/)
	const assignments = command?.trim().replace(/ npx @usecontextlayer\/cli login$/, "")
	const { stdout } = await execa("sh", [
		"-c",
		`${assignments} node -e 'process.stdout.write(JSON.stringify(process.env))'`,
	])
	expect(JSON.parse(stdout)).toMatchObject(settings)
}

test.each([
	{ clientId: "cli-client", issuer: "http://localhost:43001/api/auth" },
	{ clientId: "different-client", issuer: "https://auth.example.com/api/auth" },
])(
	"CLI explains a saved-login mismatch ($issuer, $clientId)",
	async ({ issuer, clientId }) => {
		const saved = await savedLogin("unused-access-token")
		const settings = {
			...saved,
			CTX_AUTH_CLIENT_ID: clientId,
			CTX_AUTH_ISSUER: issuer,
			CTX_PLATFORM_URL: "http://localhost:43002",
		}
		const { exitCode, stderr, stdout } = await execa(
			process.execPath,
			["--import", "tsx", fileURLToPath(new URL("../cli.ts", import.meta.url)), "whoami"],
			{
				cwd: fileURLToPath(new URL("..", import.meta.url)),
				env: settings,
				reject: false,
			},
		)
		expect(exitCode).toBe(1)
		expect(stdout).toBe("")
		expect(stderr).toContain(`Saved issuer: ${saved.CTX_AUTH_ISSUER}`)
		expect(stderr).toContain(`Expected issuer: ${issuer}`)
		if (clientId !== saved.CTX_AUTH_CLIENT_ID) {
			expect(stderr).toContain(`Saved client ID: ${saved.CTX_AUTH_CLIENT_ID}`)
			expect(stderr).toContain(`Expected client ID: ${clientId}`)
		} else {
			expect(stderr).not.toContain("client ID:")
		}
		await expectLoginCommand(stderr, settings)
	},
)

test.each(["missing", "expired"])(
	"CLI preserves selected settings for a %s login",
	async (state) => {
		const saved = await savedLogin("unused-access-token")
		const path = join(saved.CTX_CONFIG_DIR, "auth.json")
		if (state === "missing") {
			await rm(path)
		} else {
			const credentials = JSON.parse(await readFile(path, "utf8"))
			await writeFile(path, JSON.stringify({ ...credentials, expiresAt: 0 }))
		}
		const settings = { ...saved, CTX_PLATFORM_URL: "http://localhost:43002" }
		const { exitCode, stderr } = await execa(
			process.execPath,
			["--import", "tsx", fileURLToPath(new URL("../cli.ts", import.meta.url)), "whoami"],
			{
				cwd: fileURLToPath(new URL("..", import.meta.url)),
				env: settings,
				reject: false,
			},
		)
		expect(exitCode).toBe(1)
		expect(stderr).toContain(state === "missing" ? "Not signed in." : "Login expired.")
		await expectLoginCommand(stderr, settings)
	},
)
