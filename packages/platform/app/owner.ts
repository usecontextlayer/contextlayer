import type { z } from "zod"
import type { organizationSchema } from "@/auth.server"

export type Owner = { type: "user"; id: string } | { type: "organization"; id: string }

export type OwnerDetails =
	| Extract<Owner, { type: "user" }>
	| (Extract<Owner, { type: "organization" }> &
			Pick<z.infer<typeof organizationSchema>, "name" | "slug">)
