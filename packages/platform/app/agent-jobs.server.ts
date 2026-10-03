import { z } from "zod"
import { loadAgent } from "@/agents.server"
import { resolveFolder } from "@/app-folders.server"
import type { AppAccess } from "@/apps.server"
import {
	boatClient,
	commandResponseSchema,
	fileResponseSchema,
	promptEventsSchema,
	promptResponseSchema,
	promptRunSchema,
	sandboxResponseSchema,
} from "@/boat.server"
import type { PlatformDb } from "@/database"
import type { AppUserUserId } from "@/database/models/public/AppUser"
import type { PlatformConfig } from "@/env"

const HOME = "/home/user"
const RESULT = `${HOME}/result.json`

// A job is one prompt sent to an agent: one boat conversation running Claude Code in its own
// sandbox, so its id is `<sandboxId>.<conversationId>`. It runs as one person: their own Claude
// subscription from the customer-credentials Doppler config, the app's shared folders, and their
// individual folders as an app user. The sandbox receives none of the boat account's credentials.
export async function startAgentJob(
	db: PlatformDb,
	artifacts: Artifacts,
	config: PlatformConfig,
	{ app, identity }: AppAccess,
	agentName: string,
	prompt: string,
) {
	const agent = await loadAgent(artifacts, app.id, agentName)
	if (!agent) return null
	const userId = identity.user.id
	const remotes: Record<string, string> = {}
	for (const [slug, { mode }] of Object.entries(agent.manifest.folders)) {
		const appUser = mode === "shared" ? null : (userId as AppUserUserId)
		const folder = await resolveFolder(db, artifacts, app.id, appUser, slug)
		remotes[slug] = await writableRemote(artifacts, folder.id)
	}

	const boat = boatClient(config.BOAT_API_KEY)
	const { sandbox } = await boat("POST", "/sandboxes", sandboxResponseSchema, {
		env: { CLAUDE_CODE_OAUTH_TOKEN: await claudeToken(config, userId) },
		noEnv: true,
	})
	let state = sandbox.state
	while (state !== "ready" && state !== "idle") {
		await scheduler.wait(2000)
		state = (await boat("GET", `/sandboxes/${sandbox.id}`, sandboxResponseSchema)).sandbox
			.state
	}
	for (const [path, content] of Object.entries(agent.files)) {
		await boat("PUT", `/sandboxes/${sandbox.id}/files`, fileWrittenSchema, {
			content,
			path: `${HOME}/${path}`,
		})
	}
	const command = [
		'git config --global user.name "ContextLayer agent"',
		"git config --global user.email agent@contextlayer.xyz",
		...Object.entries(remotes).map(
			([slug, remote]) => `git clone --quiet ${remote} folders/${slug}`,
		),
	].join(" && ")
	const { exitCode, stderr } = await boat(
		"POST",
		`/sandboxes/${sandbox.id}/commands`,
		commandResponseSchema,
		{ command, timeoutSeconds: 120 },
	)
	if (exitCode !== 0) throw new Error(`Folder checkout exited ${exitCode}: ${stderr}`)

	const contract = `This is an autonomous job: nobody will answer questions, so make reasonable assumptions and finish.

Your folders are Git checkouts under ${HOME}/folders/: ${Object.keys(remotes).join(", ")}. Anything you want to keep must be saved there. When you are done, commit your changes in each folder you changed and push them with \`git push origin HEAD:main\`.

When you are done, write your result to ${RESULT} as a single JSON document matching this JSON Schema:
${agent.outputSchema}`
	const { conversationId } = await boat(
		"POST",
		`/sandboxes/${sandbox.id}/prompt`,
		promptResponseSchema,
		{ new: true, prompt: `${prompt}\n\n${contract}`, provider: "claude" },
	)
	return { id: `${sandbox.id}.${conversationId}` }
}

// A job's status is the status of its conversation's latest prompt run: boat stamps every event
// with the prompt id (`taskId`), so the newest `prompt` event names it.
export async function getAgentJob(config: PlatformConfig, id: string) {
	const [sandboxId, conversationId] = id.split(".")
	const boat = boatClient(config.BOAT_API_KEY)
	const { events } = await boat(
		"GET",
		`/sandboxes/${sandboxId}/events?conversation=${conversationId}&type=prompt`,
		promptEventsSchema,
	)
	const { promptRun } = await boat(
		"GET",
		`/sandboxes/${sandboxId}/prompts/${events[0].taskId}`,
		promptRunSchema,
	)
	if (promptRun.status !== "finished") return { id, status: promptRun.status }
	const { content } = await boat(
		"GET",
		`/sandboxes/${sandboxId}/files?path=${encodeURIComponent(RESULT)}`,
		fileResponseSchema,
	)
	return { id, result: JSON.parse(content) as unknown, status: promptRun.status }
}

async function writableRemote(artifacts: Artifacts, name: string) {
	using repo = await artifacts.get(name)
	const info = await repo.info()
	const token = await repo.createToken("write", 3600)
	return authenticatedRemote(info.remote, token.plaintext)
}

// An Artifacts token ends in `?expires=…`; Git authenticates with the part before it.
function authenticatedRemote(remote: string, token: string) {
	return remote.replace("https://", `https://x:${token.split("?expires=")[0]}@`)
}

// The person's own Claude subscription token. Doppler's default secret names allow only uppercase
// letters, digits, and underscores, so the user id is hex-encoded into the name.
async function claudeToken(config: PlatformConfig, userId: string) {
	const hex = Array.from(new TextEncoder().encode(userId), (byte) =>
		byte.toString(16).padStart(2, "0"),
	)
		.join("")
		.toUpperCase()
	const name = `CLAUDE_CODE_OAUTH_TOKEN_${hex}`
	const response = await fetch(
		`https://api.doppler.com/v3/configs/config/secret?name=${name}`,
		{
			headers: {
				authorization: `Bearer ${config.CTX_CUSTOMER_CREDENTIALS_DOPPLER_TOKEN}`,
			},
		},
	)
	if (!response.ok)
		throw new Error(`Doppler secret ${name} lookup failed: ${response.status}`)
	const { value } = dopplerSecretSchema.parse(await response.json())
	if (value.raw === null)
		throw new Error(`No Claude subscription token is stored as ${name}`)
	return value.raw
}

const dopplerSecretSchema = z.object({ value: z.object({ raw: z.string().nullable() }) })
const fileWrittenSchema = z.object({ path: z.string() })
