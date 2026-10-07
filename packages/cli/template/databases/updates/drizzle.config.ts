import { defineConfig } from "drizzle-kit"

export default defineConfig({
	dialect: "sqlite",
	driver: "durable-sqlite",
	out: "./databases/updates/migrations",
	schema: "./databases/updates/schema.ts",
})
