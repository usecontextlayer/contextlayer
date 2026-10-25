import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { execa } from "execa"
import { test } from "vitest"
import { createSlateProject } from "@/slate"

test("the generated starter installs, typechecks, and builds", async () => {
	await using resources = new AsyncDisposableStack()
	const checkout = await mkdtemp(join(tmpdir(), "slate-starter-"))
	resources.defer(() => rm(checkout, { force: true, recursive: true }))
	await createSlateProject(resolve(import.meta.dirname, "../../.."), checkout)
	await execa("pnpm", ["typecheck"], { cwd: checkout })
	await execa("pnpm", ["build"], { cwd: checkout, env: { NODE_ENV: undefined } })
}, 180_000)
