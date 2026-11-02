import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createSlateProject } from "@usecontextlayer/dev-env/slate"
import type { TestProject } from "vitest/node"

// Every slate project in a run starts from the same template and the same packed workspace CLI and
// SDK, so a lane creates one and each test copies it.
export default async function setup(project: TestProject) {
	const directory = await mkdtemp(join(tmpdir(), "slate-project-"))
	const checkout = join(directory, "project")
	await createSlateProject(resolve(import.meta.dirname, "../../.."), checkout)
	project.provide("slateProject", checkout)
	return () => rm(directory, { force: true, recursive: true })
}
