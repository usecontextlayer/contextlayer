#!/usr/bin/env node
import { cp } from "node:fs/promises"
import { Command } from "commander"
import { execa } from "execa"
import { z } from "zod"
import { env } from "@/env"
import { version } from "@/package.json"

const program = new Command().name("ctx").description("ContextLayer CLI").version(version)

program
	.command("init <directory>")
	.description(
		"Create a Cloudflare React Router project with local Composio tools, register an app, and set its immutable Git remote",
	)
	.action(async (directory: string) => {
		const result = await execa(
			"pnpm",
			[
				"create",
				"cloudflare@latest",
				directory,
				"--framework=react-router",
				"--accept-defaults",
				"--git",
				"--no-deploy",
				"--",
				"--yes",
			],
			{
				reject: false,
				stdio: "inherit",
			},
		)
		process.exitCode = result.exitCode
		if (result.exitCode !== 0) return

		await cp(new URL("./template/", import.meta.url), directory, { recursive: true })
		const configure = await execa(
			"pnpm",
			[
				"config",
				"set",
				"--location=project",
				"--json",
				"minimumReleaseAgeExclude",
				'["@usecontextlayer/*"]',
			],
			{ cwd: directory, reject: false, stdio: "inherit" },
		)
		process.exitCode = configure.exitCode
		if (configure.exitCode !== 0) return

		const install = await execa(
			"pnpm",
			["add", `@usecontextlayer/tools@${version}`, "zod@^4.4.3"],
			{
				cwd: directory,
				reject: false,
				stdio: "inherit",
			},
		)
		process.exitCode = install.exitCode
		if (install.exitCode !== 0) return

		const response = await fetch(new URL("/api/apps", env.CTX_PLATFORM_URL), {
			method: "POST",
		})
		if (!response.ok) throw new Error(`App creation failed: HTTP ${response.status}`)
		const app = z
			.object({ id: z.uuid(), public_hostname: z.hostname() })
			.parse(await response.json())
		const remote = new URL(`/git/${app.id}`, env.CTX_PLATFORM_URL)
		const git = await execa("git", ["remote", "add", "origin", remote.href], {
			cwd: directory,
			reject: false,
			stdio: "inherit",
		})
		process.exitCode = git.exitCode
	})

await program.parseAsync()
