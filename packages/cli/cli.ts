#!/usr/bin/env node
import { cp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Argument, Command } from "commander"
import { execa } from "execa"
import { z } from "zod"
import { runLocalAgent } from "@/agents"
import { joinApp } from "@/app"
import { getAccessToken, login, whoami } from "@/auth"
import {
	addConnection,
	assignAppConnection,
	connectionAssignmentSchema,
	listAppConnections,
	listConnections,
} from "@/connections"
import { env } from "@/env"
import { gitCredential, setupGit } from "@/git-credential"
import { ownerOptionsSchema } from "@/owner"
import { version } from "@/package.json"
import { dropSecret, secretNameSchema, secretOptionsSchema, setSecret } from "@/secrets"

const program = new Command().name("ctx").description("ContextLayer CLI").version(version)

program
	.command("init <directory>")
	.description(
		"Create a Cloudflare React Router project with Tailwind and shadcn Base UI, register and join a private app owned by you or an organization (ctx login), and set its immutable Git remote",
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

		const tsconfigPath = join(directory, "tsconfig.json")
		const tsconfig = z
			.looseObject({ compilerOptions: z.record(z.string(), z.unknown()) })
			.parse(JSON.parse(await readFile(tsconfigPath, "utf8")))
		tsconfig.compilerOptions.paths = { "@/*": ["./*"], "~/*": ["./app/*"] }
		const cloudflareTsconfigPath = join(directory, "tsconfig.cloudflare.json")
		const cloudflareTsconfig = z
			.looseObject({
				compilerOptions: z.record(z.string(), z.unknown()),
				include: z.array(z.string()),
			})
			.parse(JSON.parse(await readFile(cloudflareTsconfigPath, "utf8")))
		cloudflareTsconfig.compilerOptions.paths = tsconfig.compilerOptions.paths
		cloudflareTsconfig.include.push("databases/**/schema.ts")
		await writeFile(
			cloudflareTsconfigPath,
			`${JSON.stringify(cloudflareTsconfig, null, 2)}\n`,
		)
		await writeFile(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`)

		const ui = await execa(
			"pnpm",
			[
				"dlx",
				"shadcn@latest",
				"init",
				"--preset",
				"nova",
				"--base",
				"base",
				"--yes",
				"--no-monorepo",
			],
			{ cwd: directory, reject: false, stdio: "inherit" },
		)
		process.exitCode = ui.exitCode
		if (ui.exitCode !== 0) return

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
			["add", `@usecontextlayer/sdk@${version}`, "zod@^4.4.3", "drizzle-orm@0.45.3"],
			{
				cwd: directory,
				reject: false,
				stdio: "inherit",
			},
		)
		process.exitCode = install.exitCode
		if (install.exitCode !== 0) return

		const migrationTool = await execa("pnpm", ["add", "-D", "drizzle-kit@0.31.11"], {
			cwd: directory,
			reject: false,
			stdio: "inherit",
		})
		process.exitCode = migrationTool.exitCode
		if (migrationTool.exitCode !== 0) return
		const packagePath = join(directory, "package.json")
		const projectPackage = z
			.looseObject({ scripts: z.record(z.string(), z.string()) })
			.parse(JSON.parse(await readFile(packagePath, "utf8")))
		projectPackage.scripts["db:migration"] = "drizzle-kit generate --custom"
		await writeFile(packagePath, `${JSON.stringify(projectPackage, null, 2)}\n`)

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

program
	.command("join")
	.argument("<target>", "AppID, public hostname, or local (run from the app root)")
	.description(
		"Join a private app you can view using ctx login, enabling member-scoped unattended work; returns app and user IDs",
	)
	.action(async (target) => {
		await joinApp(z.union([z.literal("local"), z.uuid(), z.hostname()]).parse(target))
	})

const connections = program
	.command("connections")
	.description(
		"Manage Owner-owned connected accounts or list app and agent connection requirements; local reads only the current folder and its saved development choices",
	)
	.option(
		"--org <org_slug>",
		"Manage this organization's connections; defaults to the signed-in user",
	)
	.argument(
		"[target]",
		"AppID or public hostname (pushed requirements), or local (current folder; no platform request)",
	)
	.addArgument(new Argument("[operation]", "App connection operation").choices(["list"]))
	.action(async (target, operation) => {
		if (!target || !operation)
			connections.error("Expected: ctx connections <target> list")
		await listAppConnections(target)
	})

connections
	.command("list")
	.description(
		"List the selected Owner's Composio accounts with their toolkit, identity, and status",
	)
	.action(async (_options, command: Command) => {
		const options = ownerOptionsSchema.parse(command.optsWithGlobals())
		await listConnections(options.org)
	})

connections
	.command("add <toolkit>")
	.description(
		"Print a Composio authorization link for the selected Owner's account (for example, gmail)",
	)
	.action(async (toolkit, _options, command: Command) => {
		const options = ownerOptionsSchema.parse(command.optsWithGlobals())
		await addConnection(z.string().min(1).parse(toolkit), options.org)
	})

program
	.command("connection")
	.description(
		"Bind a declared slug: local saves your personal account in .contextlayer/connections.json; AppID/hostname saves a hosted assignment under its declared Owner",
	)
	.argument("<target>", "AppID, public hostname, or local (run from the app root)")
	.addArgument(new Argument("<operation>").choices(["assign"]))
	.argument("<slug>", "Connection requirement slug")
	.argument(
		"[connection_id]",
		"Connected account ID; omit locally to choose your accounts for the declared toolkit; required for hosted targets",
	)
	.action(async (target, _operation, slug, connectionId) => {
		const input = connectionAssignmentSchema.parse({
			connection_id: connectionId,
			slug,
			target,
		})
		await assignAppConnection(input.target, input.slug, input.connection_id)
	})

program
	.command("agent")
	.addArgument(new Argument("<target>", "Run from the app root").choices(["local"]))
	.addArgument(new Argument("<operation>").choices(["run"]))
	.argument("<name>", "Agent directory under agents/")
	.argument("<prompt>", "Task to send as the user message")
	.description(
		"Run agents/<name>/instructions.md locally with Claude Agent SDK and native Claude authentication; no platform server or ctx login required",
	)
	.action(async (_target, _operation, name, prompt) => {
		const input = z
			.object({
				name: z.string().min(1),
				prompt: z.string().min(1),
			})
			.parse({ name, prompt })
		console.log(await runLocalAgent(input.name, input.prompt))
	})

const secrets = program
	.command("secrets")
	.description(
		"Save or drop Owner-owned shared secrets through the authenticated platform",
	)
	.option(
		"--org <org_slug>",
		"Use this organization's Owner; defaults to the signed-in user",
	)

secrets
	.command("set")
	.argument(
		"<name>",
		"Secret name: uppercase letters, digits, and underscores; cannot start with a digit",
	)
	.description("Save a secret with a masked password prompt; returns only Owner and name")
	.option(
		"--stdin",
		"Read the exact UTF-8 value from stdin instead of prompting; preserves whitespace and newlines",
	)
	.action(async (name, _options, command: Command) => {
		const input = secretNameSchema.parse(name)
		const options = secretOptionsSchema.parse(command.optsWithGlobals())
		await setSecret(input, options)
	})

secrets
	.command("drop")
	.argument(
		"<name>",
		"Secret name: uppercase letters, digits, and underscores; cannot start with a digit",
	)
	.description("Delete the selected Owner's shared secret; returns only Owner and name")
	.action(async (name, _options, command: Command) => {
		const input = secretNameSchema.parse(name)
		const options = secretOptionsSchema.parse(command.optsWithGlobals())
		await dropSecret(input, options.org)
	})

await program.parseAsync()
