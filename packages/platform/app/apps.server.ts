import { adjectives, animals, colors, uniqueNamesGenerator } from "unique-names-generator"
import { z } from "zod"
import { type ArtifactsClient, readArtifactsResult } from "@/artifacts.server"
import type { PlatformDb } from "@/database"
import type { AppId } from "@/database/models/public/App"

export async function listApps(db: PlatformDb, artifacts: ArtifactsClient) {
	const apps = await db.selectFrom("app").selectAll().orderBy("public_hostname").execute()
	return Promise.all(
		apps.map(async (app) => {
			const commits = await readArtifactsResult(
				await artifacts.request(`/repos/${app.id}/log?ref=main&limit=1`),
				z.array(z.object({ hash: z.string() })),
			)
			return { ...app, latest_commit: commits[0]?.hash ?? null }
		}),
	)
}

export function resolveApp(db: PlatformDb, hostname: string) {
	return db
		.selectFrom("app")
		.select("id")
		.where("public_hostname", "=", hostname)
		.executeTakeFirst()
}

export function createApp(
	db: PlatformDb,
	artifacts: ArtifactsClient,
	appsDomain: string,
) {
	const name = uniqueNamesGenerator({
		dictionaries: [adjectives, colors, animals],
		separator: "-",
	})
	return db.transaction().execute(async (trx) => {
		const app = await trx
			.insertInto("app")
			.values({ public_hostname: `${name}.${appsDomain}` })
			.returningAll()
			.executeTakeFirstOrThrow()
		await readArtifactsResult(
			await artifacts.request("/repos", { default_branch: "main", name: app.id }),
			z.object({ remote: z.url() }),
		)
		return app
	})
}

export async function getGitAccess(
	db: PlatformDb,
	artifacts: ArtifactsClient,
	id: AppId,
	write: boolean,
) {
	const app = await db
		.selectFrom("app")
		.select("id")
		.where("id", "=", id)
		.executeTakeFirst()
	if (!app) return null
	const repo = await readArtifactsResult(
		await artifacts.request(`/repos/${encodeURIComponent(id)}`),
		z.object({ remote: z.url() }),
	)
	const token = await readArtifactsResult(
		await artifacts.request("/tokens", {
			repo: id,
			scope: write ? "write" : "read",
			ttl: 3600,
		}),
		z.object({ plaintext: z.string() }),
	)
	return { remote: repo.remote, token: token.plaintext }
}
