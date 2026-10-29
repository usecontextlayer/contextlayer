import type { WorkflowStep } from "cloudflare:workers"
import { type DirectoryBackup, SandboxRunner } from "@cloudflare/ci/worker"
import { DATABASE_HOST } from "@usecontextlayer/shared/databases"
import type { SlateProvisioning } from "@usecontextlayer/shared/slate-provisioning"
import type { BuildBindings } from "@/env"

export async function migrateSlateDatabases(
	env: BuildBindings,
	step: WorkflowStep,
	prepared: SlateProvisioning,
	restore?: DirectoryBackup,
) {
	if (prepared.databases.length === 0) return
	await step.do(
		"migrate slate databases",
		{ retries: { delay: "1 second", limit: 0 }, timeout: "1 hour" },
		async () => {
			using repo = await env.ARTIFACTS.get(prepared.slate.id)
			const info = await repo.info()
			const token = await repo.createToken("read", 3600)
			const targets = prepared.databases.map((database, index) => ({
				...database,
				hostname: `database-${index}.${DATABASE_HOST}`,
				index,
			}))
			// A restored workspace is the build's install of this exact commit. The runner's source overlay
			// refreshes package.json mtimes, which pnpm's default pre-run check answers with a full reinstall.
			const kysely = restore
				? "pnpm --config.verify-deps-before-run=false exec kysely"
				: "pnpm exec kysely"
			const runner = new SandboxRunner(env)
			const result = await runner.run({
				command: [
					...(restore ? [] : ["pnpm install --frozen-lockfile --ignore-scripts"]),
					...targets.flatMap(({ hostname, index, slug }) => [
						`printf '%s\\n' ${shellQuote(`Migration ${index}: ${slug}`)}`,
						`CTX_DATABASE_URL=${shellQuote(`http://${hostname}`)} ${kysely} --config ${shellQuote(`databases/${slug}/kysely.config.ts`)} migrate latest`,
					]),
				].join(" && "),
				createSnapshot: false,
				label: "migrate-databases",
				outboundByHost: Object.fromEntries(
					targets.map(({ hostname, instance_name }) => [
						hostname,
						{ method: "database", params: { instanceName: instance_name } },
					]),
				),
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
					if (text) console.log(`Migration ${channel}:\n${text}`)
				}),
			)
			if (result.exitCode !== 0)
				throw new Error(
					`Database migration failed (exit ${result.exitCode})\n${result.preview.stderr || result.preview.stdout}`,
				)
		},
	)
}

function shellQuote(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`
}
