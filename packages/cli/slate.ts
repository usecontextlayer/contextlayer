import { glob, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
	collectSlateResources,
	declarationSchema,
	type SlateDeclarations,
} from "@usecontextlayer/shared/declaration"
import { execa } from "execa"
import { z } from "zod"

export async function getLocalSlateId(directory = process.cwd()) {
	const { stdout: remote } = await execa("git", ["remote", "get-url", "origin"], {
		cwd: directory,
	})
	return z.uuid().parse(new URL(remote).pathname.replace(/^\/git\//, ""))
}

export async function readLocalResources(directory = process.cwd()) {
	return collectSlateResources(await readLocalDeclarations(directory))
}

export async function readLocalDeclarations(directory = process.cwd()) {
	const declarations: SlateDeclarations = { agents: {} }
	for await (const entry of glob("app", { cwd: directory, withFileTypes: true })) {
		if (entry.isDirectory()) {
			declarations.app = await readLocalDeclaration(join(directory, "app/slate.json"))
		}
	}
	for await (const entry of glob("agents/*", { cwd: directory, withFileTypes: true })) {
		if (entry.isDirectory()) {
			declarations.agents[entry.name] = await readLocalDeclaration(
				join(directory, "agents", entry.name, "slate.json"),
			)
		}
	}
	return declarations
}

async function readLocalDeclaration(path: string) {
	return declarationSchema.parse(JSON.parse(await readFile(path, "utf8")))
}
