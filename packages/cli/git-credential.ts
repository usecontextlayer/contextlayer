import { createInterface } from "node:readline"
import { execa } from "execa"
import { z } from "zod"
import { type AuthEnv, getAccessToken } from "@/auth"
import { formatAuthCommand } from "@/auth-command"
import type { env } from "@/env"

export async function configureGit(settings: typeof env, invocation: string) {
	const scope = new URL("/git", settings.CTX_PLATFORM_URL).href
	const key = `credential.${scope}.helper`
	const command = formatAuthCommand(invocation, "git-credential", settings)
	await execa("git", ["config", "--global", "--replace-all", key, ""])
	await execa("git", ["config", "--global", "--add", key, `!${command}`])
}

export async function gitCredential(operation: string, settings: AuthEnv) {
	if (operation === "capability") {
		process.stdout.write("version 0\ncapability authtype\n")
		return
	}
	if (operation !== "get") return

	const attributes = new URLSearchParams()
	const lines = createInterface({ input: process.stdin })
	for await (const line of lines) {
		if (line === "") break
		const separator = line.indexOf("=")
		attributes.append(line.slice(0, separator), line.slice(separator + 1))
	}
	z.literal("authtype").parse(
		attributes.getAll("capability[]").find((c) => c === "authtype"),
	)
	process.stdout.write(
		`capability[]=authtype\nauthtype=Bearer\ncredential=${await getAccessToken(settings)}\n\n`,
	)
}
