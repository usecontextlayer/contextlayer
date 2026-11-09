import { createMiddleware } from "hono/factory"
import type { PlatformEnv } from "@/context"
import { createPlatformDb } from "@/database"
import { parsePlatformEnv } from "@/env"

export const platformContext = createMiddleware<PlatformEnv>(async (c, next) => {
	const config = parsePlatformEnv(c.env)
	const db = createPlatformDb(config.CTX_PLATFORM_DATABASE_URL)
	c.set("config", config)
	c.set("db", db)
	try {
		await next()
	} finally {
		c.executionCtx.waitUntil(db.destroy())
	}
})
