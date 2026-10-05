import { readFile } from "node:fs/promises"
import { slateSchema } from "@usecontextlayer/shared/slate"
import { execa } from "execa"
import { z } from "zod"

export async function getLocalAppId() {
	const { stdout: remote } = await execa("git", ["remote", "get-url", "origin"])
	return z.uuid().parse(new URL(remote).pathname.replace(/^\/git\//, ""))
}

export async function readLocalManifest() {
	return slateSchema.parse(JSON.parse(await readFile("public/slate.json", "utf8")))
}
