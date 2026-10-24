import { test as base } from "vitest"
import { createTestHarness, type TestHarnessOptions } from "wrangler"

export interface Workers extends Array<TestHarnessOptions["workers"][number]> {}

export const test = base
	.extend("workers", [] as Workers)
	.extend("harness", ({ workers, onTestFailed }, { onCleanup }) => {
		const harness = createTestHarness({ workers })
		onTestFailed(() => harness.debug())
		onCleanup(() => harness.close())
		return harness
	})
