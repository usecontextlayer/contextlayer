import { test as base } from "vitest"
import { createTestHarness, type TestHarnessOptions } from "wrangler"

// A named interface keeps private Miniflare types out of inferred fixture declarations.
export interface Workers extends Array<TestHarnessOptions["workers"][number]> {}

// Platform expects Vite's test output, already bundled and environment-selected.
// The Wrangler projects below select "test" here and load their prebuilt scripts.
export const platformWorkerConfig = {
	configPath: new URL(
		"./packages/platform/build-test/server/wrangler.json",
		import.meta.url,
	),
} satisfies Workers[number]

export const buildWorkerConfig = {
	configPath: new URL("./packages/build/wrangler.jsonc", import.meta.url),
	env: "test",
	prebuiltWorkerDir: new URL("./packages/build/dist-test", import.meta.url),
} satisfies Workers[number]

export const dispatcherWorkerConfig = {
	configPath: new URL("./packages/dispatcher/wrangler.jsonc", import.meta.url),
	env: "test",
	prebuiltWorkerDir: new URL("./packages/dispatcher/dist-test", import.meta.url),
} satisfies Workers[number]

export const test = base
	.extend("workers", { scope: "file" }, [] as Workers)
	.extend("harness", ({ workers, task, onTestFinished }) => {
		const harness = createTestHarness({ workers })
		// Fixture teardown stops at the first cleanup error. onTestFinished still runs,
		// so the harness closes and debug() sees that cleanup failure.
		onTestFinished(async () => {
			if (task.result?.state === "fail") harness.debug()
			await harness.close()
		})
		return harness
	})
