import { z } from "zod"

export const databaseJournalSchema = z.object({
	entries: z.array(
		z.object({
			breakpoints: z.boolean(),
			idx: z.number().int().nonnegative(),
			tag: z.string().min(1),
			when: z.number(),
		}),
	),
})
export const databaseMigrationsSchema = z.object({
	journal: databaseJournalSchema,
	migrations: z.record(z.string(), z.string()),
})
export type DatabaseMigrations = z.infer<typeof databaseMigrationsSchema>

export async function readDatabaseMigrations(
	slug: string,
	read: (path: string) => Promise<string | null>,
): Promise<DatabaseMigrations> {
	const directory = `databases/${slug}/migrations`
	const contents = await read(`${directory}/meta/_journal.json`)
	if (contents === null) return { journal: { entries: [] }, migrations: {} }
	const journal = databaseJournalSchema.parse(JSON.parse(contents))
	const migrations = await Promise.all(
		journal.entries.map(async (entry) => {
			const sql = await read(`${directory}/${entry.tag}.sql`)
			if (sql === null)
				throw new Error(`Missing database migration: ${slug}/${entry.tag}.sql`)
			return [`m${entry.idx.toString().padStart(4, "0")}`, sql] as const
		}),
	)
	return { journal, migrations: Object.fromEntries(migrations) }
}

export const sqlValueSchema = z.union([z.string(), z.number(), z.null()])
export const databaseQuerySchema = z.strictObject({
	params: z.array(sqlValueSchema).default([]),
	slug: z.string().min(1),
	sql: z.string().min(1),
})
export type SqlValue = z.infer<typeof sqlValueSchema>
export const databaseResultSchema = z.object({
	columns: z.array(z.string()),
	rows: z.array(z.array(sqlValueSchema)),
	rowsRead: z.number(),
	rowsWritten: z.number(),
})
export type DatabaseResult = z.infer<typeof databaseResultSchema>
export interface Databases {
	query(slug: string, sql: string, params?: SqlValue[]): Promise<DatabaseResult>
}

export interface DatabasesBinding {
	query(...args: Parameters<Databases["query"]>): Promise<DatabaseResult | Response>
}
