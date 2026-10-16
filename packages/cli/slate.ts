import { glob, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
	collectSlateResources,
	type Declaration,
	declarationSchema,
} from "@usecontextlayer/shared/declaration"
import { execa } from "execa"
import { z } from "zod"

export async function getLocalSlateId() {
	const { stdout: remote } = await execa("git", ["remote", "get-url", "origin"])
	return z.uuid().parse(new URL(remote).pathname.replace(/^\/git\//, ""))
}

export async function readLocalResources(directory = process.cwd()) {
	const app = await readLocalDeclaration(join(directory, "public/slate.json"))
	const agents: Record<string, Declaration> = {}
	for await (const entry of glob("agents/*", { cwd: directory, withFileTypes: true })) {
		if (entry.isDirectory()) {
			agents[entry.name] = await readLocalDeclaration(
				join(directory, "agents", entry.name, "slate.json"),
			)
		}
	}
	return collectSlateResources({ agents, app })
}

async function readLocalDeclaration(path: string) {
	return declarationSchema.parse(JSON.parse(await readFile(path, "utf8")))
}
