import { z } from "zod"

export { accountSchema, accountsSchema } from "@usecontextlayer/shared/accounts"

export const personalAccountsQuerySchema = z.strictObject({
	toolkit: z.string().min(1),
})

export const connectAccountSchema = z.object({ toolkit: z.string().min(1) })
export const accountLinkSchema = z.object({ redirect_url: z.url() })
