import type { ComputerConformance } from "@tests/computer/worker"
import { expect, onTestFinished, test } from "vitest"
import { createTestHarness } from "wrangler"

test("the attached Linux computer satisfies Pi's ExecutionEnv contract", async () => {
	const harness = createTestHarness({
		workers: [{ configPath: new URL("./computer/wrangler.jsonc", import.meta.url) }],
	})
	onTestFinished(() => harness.close())
	await harness.listen()
	const worker = harness.getWorker<{
		COMPUTERS: DurableObjectNamespace<ComputerConformance>
	}>()
	const { COMPUTERS } = await worker.getEnv()
	const completed = await COMPUTERS.getByName(crypto.randomUUID()).run()
	expect(completed.length).toBeGreaterThan(0)
	console.log("Native attached-container ExecutionEnv conformance passed:", completed)
}, 300_000)
