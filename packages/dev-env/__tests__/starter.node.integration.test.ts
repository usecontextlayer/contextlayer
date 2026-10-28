import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { execa } from "execa"
import { expect, test } from "vitest"
import { createSlateProject } from "@/slate"

test("the generated starter installs, typechecks, and builds", async () => {
	await using resources = new AsyncDisposableStack()
	const checkout = await mkdtemp(join(tmpdir(), "slate-starter-"))
	resources.defer(() => rm(checkout, { force: true, recursive: true }))
	await createSlateProject(resolve(import.meta.dirname, "../../.."), checkout, {
		installDependencies: true,
	})
	const help = await execa("pnpm", ["exec", "ctx", "ci", "slate.example.com", "--help"], {
		cwd: checkout,
		env: {
			CTX_AUTH_CLIENT_ID: "help-only",
			CTX_AUTH_ISSUER: "http://localhost:1/api/auth",
			CTX_CONFIG_DIR: join(checkout, ".contextlayer/cli"),
			CTX_PLATFORM_URL: "http://localhost:1",
		},
	})
	expect(help.stdout).toContain("Workflow instance operations")
	await execa("pnpm", ["typecheck"], { cwd: checkout })
	await execa("pnpm", ["build"], { cwd: checkout, env: { NODE_ENV: undefined } })
}, 180_000)
