import { glob, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
	collectSlateResources,
	type Declaration,
	declarationSchema,
} from "@usecontextlayer/shared/declaration"
import { execa } from "execa"
import { z } from "zod"
import { getAccessToken } from "@/auth"
import { env } from "@/env"

export async function resolveSlateTarget(target: string) {
	return target === "local" ? getLocalSlateId() : target
}

export async function joinSlate(target: string) {
	const slateTarget = await resolveSlateTarget(target)
	const response = await fetch(
		new URL(`/api/slates/${encodeURIComponent(slateTarget)}/join`, env.CTX_PLATFORM_URL),
		{
			headers: { authorization: `Bearer ${await getAccessToken(env)}` },
			method: "POST",
		},
	)
	if (!response.ok) throw new Error(`Slate join failed: HTTP ${response.status}`)
	const member = z
		.object({ slate_id: z.uuid(), user_id: z.string().min(1) })
		.parse(await response.json())
	console.log(JSON.stringify(member))
}

export async function getLocalSlateId() {
	const { stdout: remote } = await execa("git", ["remote", "get-url", "origin"])
	return z.uuid().parse(new URL(remote).pathname.replace(/^\/git\//, ""))
}

export async function readLocalResources(directory = process.cwd()) {
	const app = await readLocalDeclaration(join(directory, "public/slate.json"))
	const agents: Record<string, Declaration> = {}
	for await (const entry of glob("agents/*", { cwd: directory, withFileTypes: true })) {
		if (entry.isDirectory()) {
			agents[entry.name] = await readLocalDeclaration(
				join(directory, "agents", entry.name, "slate.json"),
			)
		}
	}
	return collectSlateResources({ agents, app })
}

async function readLocalDeclaration(path: string) {
	return declarationSchema.parse(JSON.parse(await readFile(path, "utf8")))
}
