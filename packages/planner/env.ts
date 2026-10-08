import { z } from "zod"

export const env = z.object({ DV_TOKEN_FILE: z.string().default("") }).parse(process.env)

if (!env.DV_TOKEN_FILE)
	throw new Error("DV_TOKEN_FILE is required (path to a file holding the token)")
