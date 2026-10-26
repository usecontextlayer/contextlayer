import { z } from "zod"

export const sqlValueSchema = z.union([z.string(), z.number(), z.null()])
export const databaseQuerySchema = z.strictObject({
	params: z.array(sqlValueSchema).default([]),
	slug: z.string().min(1),
	sql: z.string().min(1),
})
export const DATABASE_HOST = "database.contextlayer"
export const databaseStatementSchema = databaseQuerySchema.omit({ slug: true })
export type SqlValue = z.infer<typeof sqlValueSchema>
export const databaseResultSchema = z.object({
	changes: z.number().optional(),
	columns: z.array(z.string()),
	lastInsertRowid: z.number().optional(),
	rows: z.array(z.record(z.string(), sqlValueSchema)),
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
