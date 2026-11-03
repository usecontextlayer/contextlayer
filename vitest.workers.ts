import { test as base } from "vitest"
import { createTestHarness, type TestHarnessOptions } from "wrangler"

// A named interface keeps private Miniflare types out of inferred fixture declarations.
export interface WorkerInputs extends Array<TestHarnessOptions["workers"][number]> {}

// Platform's input is Vite's test output, already bundled and environment-selected,
// so unlike the Wrangler projects below it takes no `env` or `prebuiltWorkerDir`.
export const platformWorkerInput = {
	configPath: new URL(
		"./packages/platform/build-test/server/wrangler.json",
		import.meta.url,
	),
} satisfies WorkerInputs[number]

export const buildWorkerInput = {
	configPath: new URL("./packages/build/wrangler.jsonc", import.meta.url),
	env: "test",
	prebuiltWorkerDir: new URL("./packages/build/dist-test", import.meta.url),
} satisfies WorkerInputs[number]

export const dispatcherWorkerInput = {
	configPath: new URL("./packages/dispatcher/wrangler.jsonc", import.meta.url),
	env: "test",
	prebuiltWorkerDir: new URL("./packages/dispatcher/dist-test", import.meta.url),
} satisfies WorkerInputs[number]

export const test = base
	.extend("workers", { scope: "file" }, [] as WorkerInputs)
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
