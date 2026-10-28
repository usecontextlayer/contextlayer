import { execa, type Subprocess } from "execa"

const polarCli = execa({ localDir: import.meta.dirname, preferLocal: true })

export function startPolarListener(
	url: URL,
	env: Record<string, string>,
): Subprocess<{ stdio: ["ignore", "inherit", "inherit"] }> {
	return polarCli("polar", ["webhook", "listen", url.href], {
		env,
		stdio: ["ignore", "inherit", "inherit"],
	})
}
