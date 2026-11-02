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

export const platformWorkerConfig = {
	configPath: new URL("./packages/platform/build/server/wrangler.json", import.meta.url),
	enableContainers: containerWorkers.includes("platform"),
} satisfies Workers[number]

export const buildWorkerConfig = {
	configPath: new URL("./packages/build/wrangler.jsonc", import.meta.url),
	enableContainers: containerWorkers.includes("build"),
	env: "test",
	prebuiltWorkerDir: new URL("./packages/build/dist", import.meta.url),
} satisfies Workers[number]

export const dispatcherWorkerConfig = {
	configPath: new URL("./packages/dispatcher/wrangler.jsonc", import.meta.url),
	env: "test",
	prebuiltWorkerDir: new URL("./packages/dispatcher/dist", import.meta.url),
} satisfies Workers[number]

export const test = base
	.extend("workers", { scope: "file" }, [] as Workers)
	.extend("runtime", { scope: "file" }, ({ workers }, { onCleanup }) => {
		const harness = createTestHarness({ workers })
		onCleanup(() => harness.close())
		return { harness }
	})
	.extend("harness", ({ runtime, task, onTestFinished }) => {
		const { harness } = runtime
		// Fixture cleanup precedes onTestFinished, so scenario resources retain their live bindings.
		onTestFinished(async () => {
			if (task.result?.state === "fail") harness.debug()
			try {
				await harness.reset()
			} catch (error) {
				harness.debug()
				throw error
			}
		})
		return harness
	})
