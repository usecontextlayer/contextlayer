// Ephemeral database provisioning against the repo-root docker-compose dev Postgres
// (:6489) — the one instance every non-production composition runs on: the test
// tiers AND the ephemeral dev environment. Fenced behind the `./ephemeral` export
// so the production surface (`initKysely` / `runManage` / `migrateToLatest`) never
// carries a dev DSN.
//
// Vocabulary: a BASE NAME (`ctx_pggit`) is the caller's stable key; the physical
// database NAME is the uniquified `<baseName>_<hex8>` this module generates.

import { randomBytes } from "node:crypto"
import type { Kysely } from "kysely"
import postgres from "postgres"
import { initKysely } from "@/postgres"

const PG_HOST = "postgres://postgres:postgres@127.0.0.1:6489"
const ADMIN_URL = `${PG_HOST}/postgres`

type EphemeralDatabase = { url: string; drop: () => Promise<void> }

// CREATE a uniquely-named `<baseName>_<hex8>` database so a composition never
// shares state with another. Internal: every caller goes through
// `provisionEphemeralDatabases`, whose aggregate migrate/cleanup discipline this
// primitive alone does not provide.
async function createEphemeralDatabase(baseName: string): Promise<EphemeralDatabase> {
	const name = `${baseName}_${randomBytes(4).toString("hex")}`
	const admin = postgres(ADMIN_URL, { max: 1 })
	try {
		await admin.unsafe(`CREATE DATABASE ${name}`)
	} finally {
		await admin.end()
	}
	return {
		async drop() {
			const admin2 = postgres(ADMIN_URL, { max: 1 })
			try {
				await admin2`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
					WHERE datname = ${name} AND pid <> pg_backend_pid()`
				await admin2.unsafe(`DROP DATABASE IF EXISTS ${name}`)
			} finally {
				await admin2.end()
			}
		},
		url: `${PG_HOST}/${name}`,
	}
}

export type ProvisionedDatabases<K extends string> = {
	/** One fresh `<baseName>_<hex8>` DSN per requested base name, already migrated. */
	urls: Record<K, string>
	/** Drop every database this call created — the whole teardown (destroy your
	 * own pools/handles first; a live connection blocks DROP until `drop`'s
	 * terminate sweep runs). */
	dropAll: () => Promise<void>
}

/**
 * Migrate aggregation is the one explicit divergence, chosen by the caller's
 * position in the dependency graph (see ARCHITECTURE.md "Platform Databases"):
 *
 * - `migrators` — per-key, in-process: callers at/above the composition root
 *   import each schema owner's `migrateToLatest` and pass one migrator per
 *   base name.
 * - `baseNames` + `migrate` — one batch step over the full keyed set: callers
 *   below the composition root (the slate-bridge harness, erect) that migrate
 *   via the deployment-parity `platform db.latest` subprocess. `migrate`
 *   receives EVERY requested base name's DSN as a keyed record — the caller
 *   maps base names to the `CTX_*_DATABASE_URL` env keys explicitly, and the
 *   keyed shape makes a dropped or mis-keyed base name a type error.
 *
 * The `never` fields make the modes mutually exclusive: an object carrying both
 * `migrators` and `migrate` must not compile, because the implementation would
 * silently prefer one. Let `K` INFER from the passed set — explicitly
 * instantiating it wider than `baseNames` would promise `urls` keys that were
 * never provisioned.
 */
type PerKeyMode<K extends string> = {
	migrators: Record<K, (url: string) => Promise<void>>
	baseNames?: never
	migrate?: never
}

type BatchMode<K extends string> = {
	migrators?: never
	baseNames: readonly K[]
	migrate: (urls: Record<K, string>) => Promise<void>
}

export type ProvisionEphemeralDatabasesOptions<K extends string> =
	| PerKeyMode<K>
	| BatchMode<K>

function isPerKeyMode<K extends string>(
	opts: ProvisionEphemeralDatabasesOptions<K>,
): opts is PerKeyMode<K> {
	return opts.migrators !== undefined
}

/**
 * A composition's whole database dance in one call: CREATE a fresh database per
 * base name, run the migrate step, and hand back the urls + one `dropAll`. If
 * ANY create or migrate fails, every database already created is dropped before
 * the error rethrows — a failed boot must not leak `ctx_*_<hex8>` litter.
 */
export async function provisionEphemeralDatabases<K extends string>(
	opts: ProvisionEphemeralDatabasesOptions<K>,
): Promise<ProvisionedDatabases<K>> {
	let baseNames: readonly K[]
	let migrate: (urls: Record<K, string>) => Promise<void>
	if (isPerKeyMode(opts)) {
		const { migrators } = opts
		baseNames = Object.keys(migrators) as K[]
		migrate = async (urls) => {
			await Promise.all(
				(Object.keys(migrators) as K[]).map((baseName) =>
					migrators[baseName](urls[baseName]),
				),
			)
		}
	} else {
		;({ migrate, baseNames } = opts)
	}
	// SETTLE the creates (never race them): a plain Promise.all would reject on
	// the first failure while a slower sibling is still creating — that sibling's
	// database would land after the cleanup ran and leak. allSettled waits for
	// every create's verdict, so `created` is complete before any drop decision.
	// Each fulfilled value carries its own base name, so nothing depends on
	// pairing results back to `baseNames` by position.
	const settled = await Promise.allSettled(
		baseNames.map(async (baseName) => ({
			baseName,
			db: await createEphemeralDatabase(baseName),
		})),
	)
	const created = settled
		.filter(
			(r): r is PromiseFulfilledResult<{ baseName: K; db: EphemeralDatabase }> =>
				r.status === "fulfilled",
		)
		.map((r) => r.value)
	const dropAll = async () => {
		await Promise.all(created.map(({ db }) => db.drop()))
	}
	const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected")
	if (failed) {
		await dropAll()
		throw failed.reason
	}
	const urls = Object.fromEntries(
		created.map(({ baseName, db }) => [baseName, db.url]),
	) as Record<K, string>
	try {
		await migrate(urls)
	} catch (err) {
		await dropAll()
		throw err
	}
	return { dropAll, urls }
}

/**
 * Adapt a Kysely-handle-taking migrate (pggit's published `migrateToLatest`
 * signature) into the `(url) => Promise<void>` shape the per-key mode consumes:
 * a single-connection pool for the migration, destroyed either way.
 */
export function kyselyMigrator<T>(
	migrate: (db: Kysely<T>) => Promise<void>,
): (url: string) => Promise<void> {
	return async (url) => {
		const db = initKysely<T>(postgres(url, { max: 1 }))
		try {
			await migrate(db)
		} finally {
			await db.destroy()
		}
	}
}
