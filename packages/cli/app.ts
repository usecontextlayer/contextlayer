import { execa } from "execa"
import { z } from "zod"

export async function getLocalAppId() {
	const { stdout: remote } = await execa("git", ["remote", "get-url", "origin"])
	return z.uuid().parse(new URL(remote).pathname.replace(/^\/git\//, ""))
}
