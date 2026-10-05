import { z } from "zod"

export const chromePath = "/dashboard/chrome"
export const chromeHeightSchema = z.object({
	height: z.number().finite().nonnegative(),
	type: z.literal("ctx:chrome:height"),
})
