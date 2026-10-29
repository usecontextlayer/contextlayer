import type { ComputerConformance } from "@tests/computer/worker"
import { test as base } from "@tests/workers"
import { expect } from "vitest"

const test = base.extend("workers", [
	{ configPath: new URL("./computer/wrangler.jsonc", import.meta.url) },
])

test("the attached Linux computer satisfies Pi's ExecutionEnv contract", async ({
	harness,
}) => {
	await harness.listen()
	const worker = harness.getWorker<{
		COMPUTERS: DurableObjectNamespace<ComputerConformance>
	}>()
	const { COMPUTERS } = await worker.getEnv()
	const completed = await COMPUTERS.getByName(crypto.randomUUID()).run()
	expect(completed.length).toBeGreaterThan(0)
	console.log("Native attached-container ExecutionEnv conformance passed:", completed)
}, 300_000)
