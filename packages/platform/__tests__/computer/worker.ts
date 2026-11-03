import { DurableObject } from "cloudflare:workers"
import assert from "node:assert/strict"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { getOrThrow } from "@earendil-works/pi-durable/env"
import { createEnvConformance } from "@earendil-works/pi-durable/testing"
import { RemoteExecutionEnv } from "@earendil-works/pi-env/remote"
import { createContainerConnection } from "@/agent-computer"

export default {}

export class ComputerConformance extends DurableObject {
	async run() {
		const container = this.ctx.container
		assert(container)
		const connection = createContainerConnection(container)
		const environment = new RemoteExecutionEnv({
			connection,
			cwd: "/workspace",
			id: this.ctx.id.toString(),
		})
		const cases = createEnvConformance({
			assertions: {
				deepEqual: assert.deepStrictEqual,
				greaterThan: (actual, expected) => assert(actual > expected),
				ok: assert.ok,
				partialDeepEqual: assert.partialDeepStrictEqual,
				rejects: async (operation, messageIncludes) => {
					await assert.rejects(operation, (error: Error) =>
						error.message.includes(messageIncludes),
					)
				},
				strictEqual: assert.strictEqual,
			},
			listFiles: true,
			withEnv: async (use) => {
				const cwd = getOrThrow(
					await environment.createTempDir("conformance-", BACKGROUND_CONTEXT),
				)
				try {
					await use(new RemoteExecutionEnv({ connection, cwd, id: environment.id }))
				} finally {
					getOrThrow(
						await environment.remove(cwd, { recursive: true }, BACKGROUND_CONTEXT),
					)
				}
			},
		})
		const completed: string[] = []
		try {
			for (const test of cases) {
				await test.run().catch((cause) => {
					throw new Error(test.name, { cause })
				})
				completed.push(test.name)
			}
			return completed
		} finally {
			connection.close()
			await container.destroy()
		}
	}
}
