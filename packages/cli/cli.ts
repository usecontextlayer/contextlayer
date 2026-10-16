#!/usr/bin/env node
import { cp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Argument, Command } from "commander"
import { execa } from "execa"
import { z } from "zod"
import { runLocalAgent } from "@/agents"
import { getAccessToken, getCurrentUser, LoginRequiredError, login } from "@/auth"
import {
	assignSlateConnection,
	connectAccount,
	connectionAssignmentSchema,
	listConnections,
	listSlateConnections,
} from "@/connections"
import { env } from "@/env"
import { configureGit, gitCredential } from "@/git-credential"
import { ownerOptionsSchema } from "@/owner"
import { version } from "@/package.json"
import { dropSecret, secretNameSchema, secretOptionsSchema, setSecret } from "@/secrets"
import { joinSlate } from "@/slate"

const program = new Command().name("ctx").description("ContextLayer CLI").version(version)
program.addHelpText(
	"afterAll",
	"\nEnvironment:\n  CTX_CONFIG_DIR  Saved-login directory (default: ~/.contextlayer); one login per directory.\n\nRun without a global install: npx @usecontextlayer/cli <command>",
)

async function authenticate(command: Command) {
	try {
		return await getCurrentUser(env, {
			authorization: `Bearer ${await getAccessToken(env)}`,
		})
	} catch (error) {
		if (error instanceof LoginRequiredError) {
			const lines = [error.message]
			if (error.mismatch) {
				const { saved, expected } = error.mismatch
				lines.push(`Saved issuer: ${saved.issuer}`, `Expected issuer: ${expected.issuer}`)
				if (saved.clientId !== expected.clientId)
					lines.push(
						`Saved client ID: ${saved.clientId}`,
						`Expected client ID: ${expected.clientId}`,
					)
			}
			const settings = Object.entries(env)
				.map(([key, value]) => `${key}='${value.replaceAll("'", "'\\''")}'`)
				.join(" ")
			lines.push(`Run: ${settings} npx @usecontextlayer/cli login`)
			command.error(lines.join("\n"))
		}
		throw error
	}
}

async function requireLogin(command: Command) {
	await authenticate(command)
}

program
	.command("init <directory>")
	.description(
		"Create a private ContextLayer slate on main with React Router, Tailwind, and shadcn; requires login, Node.js 24+, pnpm, and Git author identity; sets the Git remote and prints how to start and deploy the slate",
	)
	.option("--org <slug>", "Create the slate under an organization you belong to")
	.hook("preAction", requireLogin)
	.action(async (directory: string, options: { org?: string }) => {
		const input = z
			.object({ organization_slug: z.string().min(1).optional() })
			.parse({ organization_slug: options.org })
		const accessToken = await getAccessToken(env)
		const gitIdentity = await execa("git", ["var", "GIT_AUTHOR_IDENT"], {
			reject: false,
			stdio: ["inherit", "ignore", "inherit"],
		})
		process.exitCode = gitIdentity.exitCode
		if (gitIdentity.exitCode !== 0) return

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
				env: {
					GIT_CONFIG_COUNT: "1",
					GIT_CONFIG_KEY_0: "init.defaultBranch",
					GIT_CONFIG_VALUE_0: "main",
				},
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
		const checkoutPackage = z
			.looseObject({ scripts: z.record(z.string(), z.string()) })
			.parse(JSON.parse(await readFile(packagePath, "utf8")))
		checkoutPackage.scripts["db:migration"] = "drizzle-kit generate --custom"
		await writeFile(packagePath, `${JSON.stringify(checkoutPackage, null, 2)}\n`)

		const response = await fetch(new URL("/api/slates", env.CTX_PLATFORM_URL), {
			body: JSON.stringify(input),
			headers: {
				authorization: `Bearer ${accessToken}`,
				"content-type": "application/json",
			},
			method: "POST",
		})
		if (!response.ok) throw new Error(`Slate creation failed: HTTP ${response.status}`)
		const slate = z
			.object({ id: z.uuid(), public_hostname: z.hostname() })
			.parse(await response.json())
		const remote = new URL(`/git/${slate.id}`, env.CTX_PLATFORM_URL)
		const git = await execa("git", ["remote", "add", "origin", remote.href], {
			cwd: directory,
			reject: false,
			stdio: "inherit",
		})
		process.exitCode = git.exitCode
		if (git.exitCode !== 0) return

		console.log(`
ContextLayer slate created: ${slate.id}
Dashboard: ${new URL(`/dashboard/slates/${slate.id}`, env.CTX_PLATFORM_URL).href}
Hosted URL: https://${slate.public_hostname}/ (available after deployment)

Start locally:
  cd '${directory.replaceAll("'", "'\\''")}'
  pnpm dev
Open the local URL printed by the development server.

Deploy your changes:
  git add .
  git commit
  git push -u origin main

See README.md for the development and connection workflow.
`)
	})

program
	.command("login")
	.description(
		"Sign in by approving a browser code and configure Git credentials for ContextLayer repositories",
	)
	.action(async () => {
		await login(env)
		await configureGit(new URL(import.meta.url))
		console.log("Git credentials configured for ContextLayer.")
	})
program
	.command("git-credential <operation>")
	.description(
		"Git credential helper using the saved login; invoked automatically by Git",
	)
	.hook("preAction", async (command) => {
		if (command.args[0] === "get") await requireLogin(command)
	})
	.action(gitCredential)
program
	.command("whoami")
	.description("Show your ContextLayer user ID verified by the auth server")
	.action(async (_options, command: Command) => {
		console.log((await authenticate(command)).id)
	})

program
	.command("join")
	.argument("<target>", "SlateID, public hostname, or local (run from the checkout root)")
	.description(
		"Join a private slate you can view using ctx login, enabling member-scoped unattended work; returns slate and user IDs",
	)
	.hook("preAction", requireLogin)
	.action(async (target) => {
		await joinSlate(z.union([z.literal("local"), z.uuid(), z.hostname()]).parse(target))
	})

const connections = program
	.command("connections")
	.description(
		"Manage Owner-owned connected accounts or list app and agent connections and assignments; local reads only the current checkout and its saved development assignments",
	)
	.option(
		"--org <slug>",
		"Manage this organization's connected accounts; defaults to the signed-in user",
	)
	.argument(
		"[target]",
		"SlateID or public hostname (pushed requirements), or local (current checkout; no platform request)",
	)
	.addArgument(
		new Argument("[operation]", "Slate connection operation").choices(["list"]),
	)
	.hook("preAction", async (command, actionCommand) => {
		if (actionCommand !== command || command.args[0] !== "local") {
			await requireLogin(actionCommand)
		}
	})
	.action(async (target, operation) => {
		if (!target || !operation)
			connections.error("Expected: ctx connections <target> list")
		await listSlateConnections(target)
	})

connections
	.command("list")
	.description(
		"List the selected Owner's connected accounts with their toolkit, identity, and status",
	)
	.action(async (_options, command: Command) => {
		const options = ownerOptionsSchema.parse(command.optsWithGlobals())
		await listConnections(options.org)
	})

connections
	.command("add <toolkit>")
	.description(
		"Connect the selected Owner's account in your browser (for example, gmail), then assign the connected account to a slate's declared connection with ctx connection",
	)
	.action(async (toolkit, _options, command: Command) => {
		const options = ownerOptionsSchema.parse(command.optsWithGlobals())
		await connectAccount(z.string().min(1).parse(toolkit), options.org)
	})

program
	.command("connection")
	.description(
		"Assign a connected account to a declared connection: local saves a personal connected account assignment in .contextlayer/connections.json; SlateID/hostname saves a hosted assignment under its declared Owner",
	)
	.argument("<target>", "SlateID, public hostname, or local (run from the checkout root)")
	.addArgument(new Argument("<operation>").choices(["assign"]))
	.argument("<slug>", "Connection slug declared in slate.json (for example, work-email)")
	.argument(
		"[connection_id]",
		"Connected account ID; omit locally to assign a connected account for the declared toolkit interactively; required for hosted targets",
	)
	.hook("preAction", requireLogin)
	.action(async (target, _operation, slug, connectionId) => {
		const input = connectionAssignmentSchema.parse({
			connection_id: connectionId,
			slug,
			target,
		})
		await assignSlateConnection(input.target, input.slug, input.connection_id)
	})

program
	.command("agent")
	.addArgument(new Argument("<target>", "Run from the checkout root").choices(["local"]))
	.addArgument(new Argument("<operation>").choices(["run"]))
	.argument("<name>", "Agent directory under agents/")
	.argument("<prompt>", "Task to send as the user message")
	.description(
		"Run agents/<name>/instructions.md locally with Claude Agent SDK and native Claude authentication; Vite startup also requires ctx login when the app declares connections",
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
	.option("--org <slug>", "Use this organization's Owner; defaults to the signed-in user")
	.hook("preAction", requireLogin)

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
