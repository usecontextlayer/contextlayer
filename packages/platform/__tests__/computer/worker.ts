import { DurableObject } from "cloudflare:workers"
import assert from "node:assert/strict"
import { type ExecutionEnv, getOrThrow } from "@earendil-works/pi-durable/env"
import { createEnvConformance } from "@earendil-works/pi-durable/testing"
import { RemoteExecutionEnv } from "@earendil-works/pi-env/remote"
import { createContainerConnection } from "@usecontextlayer/shared/agent-computer"

export default {}

const context: Parameters<ExecutionEnv["createTempDir"]>[1] = {
	abortSignal: undefined,
	toString: () => "computer-conformance",
	value: () => undefined,
}

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
				const cwd = getOrThrow(await environment.createTempDir("conformance-", context))
				try {
					await use(new RemoteExecutionEnv({ connection, cwd, id: environment.id }))
				} finally {
					getOrThrow(await environment.remove(cwd, { recursive: true }, context))
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
