import { z } from "zod"

export const inspectionConfigurationSchema = z.object({
	account_id: z.string().min(1),
	dispatch_namespace: z.string().min(1),
	script_name: z.uuid(),
	workflow_name: z.string().min(1),
})

export type InspectionConfiguration = z.infer<typeof inspectionConfigurationSchema>

export const INSPECTION_SLATE_HEADER = "X-ContextLayer-Slate"
