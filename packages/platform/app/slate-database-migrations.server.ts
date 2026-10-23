import type { DirectoryBackup } from "@cloudflare/ci/worker"
import { DATABASE_HOST } from "@usecontextlayer/shared/databases"
import type { SlateProvisioning } from "@usecontextlayer/shared/slate-provisioning"
import type { PlatformEnv } from "@/context"

export async function migrateSlateDatabases(
	artifacts: Artifacts,
	sandbox: PlatformEnv["Bindings"]["SANDBOX"],
	prepared: SlateProvisioning,
	restore?: DirectoryBackup,
) {
	if (prepared.databases.length === 0) return
	const { SandboxRunner } = await import("@cloudflare/ci/worker")
	using repo = await artifacts.get(prepared.slate.id)
	const info = await repo.info()
	const token = await repo.createToken("read", 3600)
	const runner = new SandboxRunner({ SANDBOX: sandbox })
	for (const database of prepared.databases) {
		const result = await runner.run({
			command: `${restore ? "" : "pnpm install --frozen-lockfile && "}pnpm exec kysely --config "$CTX_DATABASE_CONFIG" migrate latest`,
			createSnapshot: false,
			extraEnv: {
				CTX_DATABASE_CONFIG: `databases/${database.slug}/kysely.config.ts`,
				CTX_DATABASE_URL: `http://${DATABASE_HOST}`,
			},
			label: `migrate-${database.slug}`,
			outboundByHost: {
				[DATABASE_HOST]: {
					method: "database",
					params: { instanceName: database.instance_name },
				},
			},
			restore,
			source: {
				kind: "git",
				remote: info.remote,
				sha: prepared.snapshot.commit,
				token: token.plaintext,
			},
		})
		await Promise.all(
			Object.entries(result.logs).map(async ([channel, output]) => {
				const text =
					typeof output === "string" ? output : await new Response(output).text()
				if (text) console.log(`Migration ${database.slug} ${channel}:\n${text}`)
			}),
		)
		if (result.exitCode !== 0)
			throw new Error(
				`Migration failed for "${database.slug}" (exit ${result.exitCode})\n${result.preview.stderr || result.preview.stdout}`,
			)
	}
}
