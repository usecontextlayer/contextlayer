import { slateResourcesSchema as resourcesResponseSchema } from "@usecontextlayer/shared/slate-resources"
import { z } from "zod"
import { slateSchema } from "@/slates.schema"

export const slateResourcesRequestSchema = z.strictObject({})

export const slateResourcesSchema = resourcesResponseSchema.extend({ slate: slateSchema })
