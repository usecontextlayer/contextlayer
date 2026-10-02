// Assertions check THIS CALL's databases (by exact name, or as a delta over a
// baseline) — never "the prefix is empty". Global-prefix assertions trip over
// leftovers from a previously killed run (the documented SIGKILL leak mode)
// and over concurrent compositions, both of which are normal here.

import postgres from "postgres"
import { expect, test } from "vitest"
import { provisionEphemeralDatabases } from "@/ephemeral"

const ADMIN_URL = "postgres://postgres:postgres@127.0.0.1:6489/postgres"

async function listLiveDatabaseNames(prefix: string): Promise<string[]> {
	const admin = postgres(ADMIN_URL, { max: 1 })
	try {
		const rows = await admin`SELECT datname FROM pg_database
			WHERE datname LIKE ${`${prefix}%`}`
		return rows.map((row) => row.datname as string)
	} finally {
		await admin.end()
	}
}

function databaseNamesFromUrls(urls: Record<string, string>): string[] {
	return Object.values(urls).map((url) => url.slice(url.lastIndexOf("/") + 1))
}

test("per-key mode migrates each database with its own migrator and dropAll reclaims them", async () => {
	const migrated: string[] = []
	const provisioned = await provisionEphemeralDatabases({
		migrators: {
			ctx_ephemeral_pk_one: async (url) => {
				migrated.push(url)
			},
			ctx_ephemeral_pk_two: async (url) => {
				migrated.push(url)
			},
		},
	})
	expect(Object.keys(provisioned.urls).sort()).toEqual([
		"ctx_ephemeral_pk_one",
		"ctx_ephemeral_pk_two",
	])
	expect(migrated.sort()).toEqual(Object.values(provisioned.urls).sort())
	const names = databaseNamesFromUrls(provisioned.urls)
	expect(await listLiveDatabaseNames("ctx_ephemeral_pk_")).toEqual(
		expect.arrayContaining(names),
	)

	await provisioned.dropAll()
	const after = await listLiveDatabaseNames("ctx_ephemeral_pk_")
	for (const name of names) {
		expect(after).not.toContain(name)
	}
})

test("batch mode hands ONE migrate step the full keyed url record, exactly once", async () => {
	const calls: Record<string, string>[] = []
	const provisioned = await provisionEphemeralDatabases({
		baseNames: ["ctx_ephemeral_ba_one", "ctx_ephemeral_ba_two"],
		migrate: async (urls) => {
			calls.push(urls)
		},
	})
	try {
		expect(calls).toEqual([provisioned.urls])
		expect(Object.keys(provisioned.urls).sort()).toEqual([
			"ctx_ephemeral_ba_one",
			"ctx_ephemeral_ba_two",
		])
	} finally {
		await provisioned.dropAll()
	}
	const after = await listLiveDatabaseNames("ctx_ephemeral_ba_")
	for (const name of databaseNamesFromUrls(provisioned.urls)) {
		expect(after).not.toContain(name)
	}
})

test("a failed create drops the sibling that succeeded — no leak", async () => {
	// "bad-name" is an invalid unquoted identifier, so its CREATE DATABASE fails
	// while the valid sibling's create succeeds; the settle discipline must then
	// reclaim the sibling before rethrowing. The doomed sibling's generated name
	// never escapes a rejected call, so this one asserts as a baseline delta.
	const baseline = await listLiveDatabaseNames("ctx_ephemeral_cf_")
	await expect(
		provisionEphemeralDatabases({
			baseNames: ["ctx_ephemeral_cf_ok", "bad-name"],
			migrate: async () => {},
		}),
	).rejects.toThrow()
	expect(await listLiveDatabaseNames("ctx_ephemeral_cf_")).toEqual(baseline)
})

test("a failed migrate drops every created database before rethrowing", async () => {
	// The urls handed to the failing migrate are the only place the doomed
	// names escape — capture them so the leak check is exact-name, immune to
	// leftovers from killed runs and to concurrent compositions.
	let doomed: string[] = []
	await expect(
		provisionEphemeralDatabases({
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

test("two concurrent provisions of the same base coexist under distinct <base>_<hex8> names", async () => {
	const [first, second] = await Promise.all([
		provisionEphemeralDatabases({
			baseNames: ["ctx_ephemeral_cc"],
			migrate: async () => {},
		}),
		provisionEphemeralDatabases({
			baseNames: ["ctx_ephemeral_cc"],
			migrate: async () => {},
		}),
	])
	try {
		const [firstName] = databaseNamesFromUrls(first.urls)
		const [secondName] = databaseNamesFromUrls(second.urls)
		expect(firstName).toMatch(/^ctx_ephemeral_cc_[0-9a-f]{8}$/)
		expect(secondName).toMatch(/^ctx_ephemeral_cc_[0-9a-f]{8}$/)
		expect(firstName).not.toBe(secondName)
		const live = await listLiveDatabaseNames("ctx_ephemeral_cc_")
		expect(live).toEqual(expect.arrayContaining([firstName, secondName]))
	} finally {
		await Promise.all([first.dropAll(), second.dropAll()])
	}
})
