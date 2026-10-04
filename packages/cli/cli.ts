#!/usr/bin/env node
import { cp } from "node:fs/promises"
import { Argument, Command } from "commander"
import { execa } from "execa"
import { z } from "zod"
import { getAccessToken, login, whoami } from "@/auth"
import {
	addConnection,
	assignAppConnection,
	listAppConnections,
	listConnections,
} from "@/connections"
import { env } from "@/env"
import { gitCredential, setupGit } from "@/git-credential"
import { version } from "@/package.json"

const program = new Command().name("ctx").description("ContextLayer CLI").version(version)

program
	.command("init <directory>")
	.description(
		"Create a Cloudflare React Router project, register an app owned by you or an organization (ctx login), and set its immutable Git remote",
	)
	.option("--org <slug>", "Create the app under an organization you belong to")
	.action(async (directory: string, options: { org?: string }) => {
		const input = z
			.object({ organization_slug: z.string().min(1).optional() })
			.parse({ organization_slug: options.org })
		const accessToken = await getAccessToken()
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
			["add", `@usecontextlayer/sdk@${version}`, "zod@^4.4.3"],
			{
				cwd: directory,
				reject: false,
				stdio: "inherit",
			},
		)
		process.exitCode = install.exitCode
		if (install.exitCode !== 0) return

		const response = await fetch(new URL("/api/apps", env.CTX_PLATFORM_URL), {
			body: JSON.stringify(input),
			headers: {
				authorization: `Bearer ${accessToken}`,
				"content-type": "application/json",
			},
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

program
	.command("login")
	.description(
		"Sign in by approving a browser code and configure Git credentials for ContextLayer repositories",
	)
	.action(async () => {
		await login()
		await setupGit(new URL(import.meta.url))
		console.log("Git credentials configured for ContextLayer.")
	})
program
	.command("git-credential <operation>")
	.description(
		"Git credential helper using the saved login; invoked automatically by Git",
	)
	.action(gitCredential)
program
	.command("whoami")
	.description("Show your ContextLayer user ID using the saved login")
	.action(whoami)

const connections = program
	.command("connections")
	.description("Manage your connected accounts")
	.argument("[target]", "AppID, public hostname, or local (run from the app root)")
	.addArgument(new Argument("[operation]", "App connection operation").choices(["list"]))
	.action(async (target, operation) => {
		if (!target || !operation)
			connections.error("Expected: ctx connections <target> list")
		await listAppConnections(target)
	})

connections
	.command("list")
	.description("List your Composio accounts with their toolkit, identity, and status")
	.action(listConnections)

connections
	.command("add <toolset>")
	.description(
		"Print a Composio authorization link to connect an account (for example, gmail)",
	)
	.action(addConnection)

program
	.command("connection")
	.description("Assign a connection to an app requirement")
	.argument("<target>", "AppID, public hostname, or local (run from the app root)")
	.addArgument(new Argument("<operation>").choices(["assign"]))
	.argument("<slug>", "Connection requirement slug")
	.argument("<connection_id>", "Composio connected-account ID")
	.action(async (target, _operation, slug, connectionId) => {
		await assignAppConnection(target, slug, connectionId)
	})

await program.parseAsync()
