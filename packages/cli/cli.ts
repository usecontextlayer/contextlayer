#!/usr/bin/env node
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { databaseSlugSchema } from "@usecontextlayer/shared/declaration"
import { Argument, Command } from "commander"
import { execa } from "execa"
import { z } from "zod"
import { connectAccount, listAccounts } from "@/accounts"
import { runLocalAgent } from "@/agents"
import { getAccessToken, getCurrentUser, LoginRequiredError, login } from "@/auth"
import {
	assignSlateConnection,
	connectionsCommandSchema,
	listSlateConnections,
} from "@/connections"
import { env } from "@/env"
import { configureGit, gitCredential } from "@/git-credential"
import { ownerOptionsSchema } from "@/owner"
import { version } from "@/package.json"
import { dropSecret, secretNameSchema, secretOptionsSchema, setSecret } from "@/secrets"

const program = new Command().name("ctx").description("ContextLayer CLI").version(version)
program.addHelpText(
	"afterAll",
	`\nEnvironment (current values):\n  CTX_PLATFORM_URL    ${env.CTX_PLATFORM_URL}\n  CTX_AUTH_ISSUER     ${env.CTX_AUTH_ISSUER}\n  CTX_AUTH_CLIENT_ID  ${env.CTX_AUTH_CLIENT_ID}\n  CTX_CONFIG_DIR      ${env.CTX_CONFIG_DIR}  Saved-login directory; one login per directory.\n\nRun without a global install: npx @usecontextlayer/cli <command>`,
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
		"Create a private ContextLayer slate on main with React Router, Tailwind, and shadcn; requires login, Node.js 22.22.0+, pnpm, and Git author identity; sets the Git remote and prints how to start and deploy the slate",
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
			process.execPath,
			[
				fileURLToPath(
					new URL(
						"./dist/cli.js",
						import.meta.resolve("create-react-router/package.json"),
					),
				),
				directory,
				"--template",
				fileURLToPath(new URL("./template.tar.gz", import.meta.url)),
				"--package-manager",
				"pnpm",
				"--install",
				"--git-init",
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

Deploy the committed starter:
  git push -u origin main

Commit your own changes before subsequent pushes.

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
	.description(
		"Show your ContextLayer user ID verified by the auth server, with the issuer and platform URL in use",
	)
	.action(async (_options, command: Command) => {
		const { id } = await authenticate(command)
		console.log(
			`User: ${id}\nIssuer: ${env.CTX_AUTH_ISSUER}\nPlatform: ${env.CTX_PLATFORM_URL}`,
		)
	})

const accounts = program
	.command("accounts")
	.description("Connect and list the selected Owner's connected accounts")
	.option(
		"--org <slug>",
		"Manage this organization's connected accounts; defaults to the signed-in user",
	)
	.hook("preAction", requireLogin)

accounts
	.command("list")
	.description(
		"List the selected Owner's connected accounts with their toolkit, identity, and status",
	)
	.action(async (_options, command: Command) => {
		const options = ownerOptionsSchema.parse(command.optsWithGlobals())
		await listAccounts(options.org)
	})

accounts
	.command("add <toolkit>")
	.description(
		"Connect the selected Owner's account in your browser (for example, gmail), then assign it with ctx connections <target> assign <slug> [connection_id]",
	)
	.action(async (toolkit, _options, command: Command) => {
		const options = ownerOptionsSchema.parse(command.optsWithGlobals())
		await connectAccount(z.string().min(1).parse(toolkit), options.org)
	})

program
	.command("connections")
	.description(
		"List declared app and agent connections or assign connected accounts; local reads and saves checkout configuration, SlateID/hostname uses pushed declarations and hosted assignments",
	)
	.argument("<target>", "SlateID, public hostname, or local (run from the checkout root)")
	.addArgument(new Argument("<operation>").choices(["list", "assign"]))
	.argument(
		"[slug]",
		"Required for assign: connection slug declared in slate.json (for example, work-email)",
	)
	.argument(
		"[connection_id]",
		"For assign: connected account ID; omit locally to choose interactively; required for hosted targets",
	)
	.action(async (target, operation, slug, connectionId, _options, command: Command) => {
		const parsed = connectionsCommandSchema.safeParse({
			connection_id: connectionId,
			operation,
			slug,
			target,
		})
		if (!parsed.success)
			command.error(parsed.error.issues.map((issue) => issue.message).join("\n"))
		const input = parsed.data
		if (input.operation !== "list" || input.target !== "local")
			await requireLogin(command)
		switch (input.operation) {
			case "list":
				await listSlateConnections(input.target)
				break
			case "assign":
				await assignSlateConnection(input.target, input.slug, input.connection_id)
				break
			default:
				throw new Error(
					`Unhandled connections operation: ${JSON.stringify(input satisfies never)}`,
				)
		}
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

program
	.command("db.codegen")
	.argument(
		"<slug>",
		"Database declared in public/slate.json or agents/<name>/slate.json",
	)
	.description("Generate databases/<slug>/types.ts from the migrated local database")
	.addHelpText(
		"after",
		"\nRun from the slate root with pnpm dev running.\nApply migrations with pnpm exec kysely before generating types.\n\nExample:\n  pnpm db.codegen notes",
	)
	.action(async (slug, _options, command: Command) => {
		const { generateDatabaseTypes } = await import("@/database-codegen")
		try {
			await generateDatabaseTypes(databaseSlugSchema.parse(slug))
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "ENOENT" &&
				"path" in error &&
				error.path === resolve("public/slate.json")
			) {
				command.error(
					`Missing ${error.path}. Run pnpm db.codegen from the slate root containing public/slate.json.`,
				)
			}
			throw error
		}
	})

await program.parseAsync()
