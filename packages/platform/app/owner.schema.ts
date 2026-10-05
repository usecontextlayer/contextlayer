import { z } from "@hono/zod-openapi"

export const ownerParamsSchema = z.object({
	owner_id: z.string().min(1),
	type: z
		.enum(["org", "user"])
		.transform((type) => (type === "org" ? "organization" : "user")),
})
