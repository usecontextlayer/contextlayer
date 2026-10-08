import { glob, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
	collectAppResources,
	type Slate,
	slateSchema,
} from "@usecontextlayer/shared/slate"
import { execa } from "execa"
import { z } from "zod"
import { getAccessToken } from "@/auth"
import { env } from "@/env"

export async function resolveAppTarget(target: string) {
	return target === "local" ? getLocalAppId() : target
}

export async function joinApp(target: string) {
	const appTarget = await resolveAppTarget(target)
	const response = await fetch(
		new URL(`/api/apps/${encodeURIComponent(appTarget)}/join`, env.CTX_PLATFORM_URL),
		{
			headers: { authorization: `Bearer ${await getAccessToken(env)}` },
			method: "POST",
		},
	)
	if (!response.ok) throw new Error(`App join failed: HTTP ${response.status}`)
	const member = z
		.object({ app_id: z.uuid(), user_id: z.string().min(1) })
		.parse(await response.json())
	console.log(JSON.stringify(member))
}

export async function getLocalAppId() {
	const { stdout: remote } = await execa("git", ["remote", "get-url", "origin"])
	return z.uuid().parse(new URL(remote).pathname.replace(/^\/git\//, ""))
}

export async function readLocalResources(directory = process.cwd()) {
	const app = await readLocalSlate(join(directory, "public/slate.json"))
	const agents: Record<string, Slate> = {}
	for await (const entry of glob("agents/*", { cwd: directory, withFileTypes: true })) {
		if (entry.isDirectory()) {
			agents[entry.name] = await readLocalSlate(
				join(directory, "agents", entry.name, "slate.json"),
			)
		}
	}
	return collectAppResources({ agents, app })
}

async function readLocalSlate(path: string) {
	return slateSchema.parse(JSON.parse(await readFile(path, "utf8")))
}
