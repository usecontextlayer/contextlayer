import { test as base, inject } from "vitest"
import { createTestHarness, type TestHarnessOptions } from "wrangler"

export interface Workers extends Array<TestHarnessOptions["workers"][number]> {}

declare module "vitest" {
	export interface ProvidedContext {
		containerWorkers: ("build" | "platform")[]
	}
}

// Disabling unused container bindings avoids image preparation. Agent jobs still need their computer's
// container binding even when Code Mode never starts the container.
const containerWorkers = inject("containerWorkers")

// Harnesses load each Worker's built output. React Router owns platform compilation; Build's and the
// dispatcher's own `build` scripts write their bundles, and the platform lanes' Turbo tasks depend on them.
export const platformWorkerConfig = {
	configPath: new URL("../wrangler.jsonc", import.meta.url),
	enableContainers: containerWorkers.includes("platform"),
	env: "test",
	prebuiltWorkerDir: new URL("../build/server", import.meta.url),
} satisfies Workers[number]

export const buildWorkerConfig = {
	configPath: new URL("../../build/wrangler.jsonc", import.meta.url),
	enableContainers: containerWorkers.includes("build"),
	env: "test",
	prebuiltWorkerDir: new URL("../../build/dist", import.meta.url),
} satisfies Workers[number]

export const dispatcherWorkerConfig = {
	configPath: new URL("../../dispatcher/wrangler.jsonc", import.meta.url),
	env: "test",
	prebuiltWorkerDir: new URL("../../dispatcher/dist", import.meta.url),
} satisfies Workers[number]

export const test = base
	.extend("workers", [] as Workers)
	.extend("harness", ({ workers, onTestFailed }, { onCleanup }) => {
		const harness = createTestHarness({ workers })
		onTestFailed(() => harness.debug())
		onCleanup(() => harness.close())
		return harness
	})
