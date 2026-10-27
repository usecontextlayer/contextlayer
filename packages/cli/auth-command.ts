import type { env } from "@/env"

export function formatAuthCommand(
	invocation: string,
	command: "login" | "git-credential",
	settings: typeof env,
) {
	const args = [
		command,
		"--auth-client-id",
		settings.CTX_AUTH_CLIENT_ID,
		"--auth-issuer",
		settings.CTX_AUTH_ISSUER,
		"--config-dir",
		settings.CTX_CONFIG_DIR,
		"--platform-url",
		settings.CTX_PLATFORM_URL,
	]
		.map((argument) => `'${argument.replaceAll("'", "'\\''")}'`)
		.join(" ")
	return `CTX_CLI_COMMAND='${invocation.replaceAll("'", "'\\''")}' ${invocation} ${args}`
}
