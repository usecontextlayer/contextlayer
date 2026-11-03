import postgres from "postgres"
import { expect, test } from "vitest"
import { provisionEphemeralDatabases } from "@/database"
import { readDevEnv } from "@/env"

const databaseUrl = readDevEnv().CTX_PLATFORM_DATABASE_URL
const adminUrl = new URL(databaseUrl)
adminUrl.pathname = "/postgres"

// Other runs can share the prefix; only this run's exact names establish a leak.
async function listLiveDatabaseNames(prefix: string): Promise<string[]> {
	const admin = postgres(adminUrl.href, { max: 1 })
	try {
		const rows = await admin`SELECT datname FROM pg_database
			WHERE datname LIKE ${`${prefix}%`}`
		return rows.map((row) => row.datname as string)
	} finally {
		await admin.end()
	}
}

function databaseNamesFromUrls(urls: Record<string, string>): string[] {
	return Object.values(urls).map((url) => new URL(url).pathname.slice(1))
}

test.for(["per-key", "batch"] as const)(
	"%s mode returns migrated databases and dropAll reclaims them",
	async (mode) => {
		const migrate = async (url: string, marker: string) => {
			const sql = postgres(url, { max: 1 })
			try {
				await sql`CREATE TABLE migration_proof (value text NOT NULL)`
				await sql`INSERT INTO migration_proof VALUES (${marker})`
			} finally {
				await sql.end()
			}
		}
		const baseNames = ["ctx_ephemeral_one", "ctx_ephemeral_two"] as const
		const provisioned = await provisionEphemeralDatabases(
			databaseUrl,
			mode === "per-key"
				? {
						migrators: {
							ctx_ephemeral_one: (url) => migrate(url, "ctx_ephemeral_one"),
							ctx_ephemeral_two: (url) => migrate(url, "ctx_ephemeral_two"),
						},
					}
				: {
						baseNames,
						migrate: async (urls) => {
							await Promise.all(baseNames.map((name) => migrate(urls[name], name)))
						},
					},
		)
		const names = databaseNamesFromUrls(provisioned.urls)
		try {
			expect(Object.keys(provisioned.urls).sort()).toEqual(baseNames)
			for (const name of baseNames) {
				const sql = postgres(provisioned.urls[name], { max: 1 })
				try {
					expect(await sql`SELECT value FROM migration_proof`).toEqual([{ value: name }])
				} finally {
					await sql.end()
				}
			}
		} finally {
			await provisioned.dropAll()
		}
		const after = await listLiveDatabaseNames("ctx_ephemeral_")
		for (const name of names) expect(after).not.toContain(name)
	},
)

test("a failed migrate drops every created database before rethrowing", async () => {
	// A rejected provisioning call returns no handles; record its names before migration fails.
	let doomed: string[] = []
	await expect(
		provisionEphemeralDatabases(databaseUrl, {
			baseNames: ["ctx_ephemeral_mf_one", "ctx_ephemeral_mf_two"],
			migrate: async (urls) => {
				doomed = databaseNamesFromUrls(urls)
				throw new Error("migrate exploded")
			},
		}),
	).rejects.toThrow("migrate exploded")
	expect(doomed).toHaveLength(2)
	const after = await listLiveDatabaseNames("ctx_ephemeral_mf_")
	for (const name of doomed) {
		expect(after).not.toContain(name)
	}
})

test("two concurrent provisions of the same base coexist as distinct databases", async () => {
	const [first, second] = await Promise.all([
		provisionEphemeralDatabases(databaseUrl, {
			baseNames: ["ctx_ephemeral_cc"],
			migrate: async () => {},
		}),
		provisionEphemeralDatabases(databaseUrl, {
			baseNames: ["ctx_ephemeral_cc"],
			migrate: async () => {},
		}),
	])
	try {
		const [firstName] = databaseNamesFromUrls(first.urls)
		const [secondName] = databaseNamesFromUrls(second.urls)
		expect(firstName).not.toBe(secondName)
		const live = await listLiveDatabaseNames("ctx_ephemeral_cc_")
		expect(live).toEqual(expect.arrayContaining([firstName, secondName]))
	} finally {
		await Promise.all([first.dropAll(), second.dropAll()])
	}
})
