import { z } from "zod"

export const credentialModeSchema = z.enum(["viewer", "owner"])
export type CredentialMode = z.infer<typeof credentialModeSchema>

export const connectionRequirementSchema = z.strictObject({
	mode: credentialModeSchema,
	toolkit: z.string().min(1),
})
export const secretNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/)
export const secretRequirementSchema = z.strictObject({ mode: credentialModeSchema })

export const slateSchema = z.strictObject({
	connections: z.record(z.string().min(1), connectionRequirementSchema),
	secrets: z.record(secretNameSchema, secretRequirementSchema).default({}),
})
export type Slate = z.infer<typeof slateSchema>
