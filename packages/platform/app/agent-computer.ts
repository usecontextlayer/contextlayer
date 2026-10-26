import assert from "node:assert/strict"
import { Connection } from "@earendil-works/pi-env/remote"

export const COMPUTER_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000

export function createContainerConnection(container: Container): Connection {
	return new Connection({
		start: async (token) => {
			if (!container.running) {
				container.start({
					enableInternet: false,
					entrypoint: ["sleep", "infinity"],
					image: container.images.workspace,
				})
			}
			await container.setInactivityTimeout(COMPUTER_INACTIVITY_TIMEOUT_MS)
			const process = await container.exec(
				["/usr/local/bin/pi-env", "serve", "--token", token],
				{ cwd: "/workspace", stdin: "pipe" },
			)
			assert(process.stdin && process.stdout && process.stderr)
			return {
				close: () => process.kill(),
				exited: process.exitCode,
				stderr: process.stderr,
				stdin: process.stdin,
				stdout: process.stdout,
			}
		},
	})
}
