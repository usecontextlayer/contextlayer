import { z } from "zod"

export const userSchema = z.object({
	id: z.string().min(1),
	image: z.string().nullable(),
	name: z.string(),
})

export type User = z.infer<typeof userSchema>

export interface Viewer {
	getCurrentUser(): Promise<User | null>
}
