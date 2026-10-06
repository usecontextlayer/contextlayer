import { appResourcesSchema as resourcesResponseSchema } from "@usecontextlayer/shared/app-resources"
import { z } from "zod"
import { appSchema } from "@/apps.schema"

export const appResourcesRequestSchema = z.strictObject({})

export const appResourcesSchema = resourcesResponseSchema.extend({ app: appSchema })
