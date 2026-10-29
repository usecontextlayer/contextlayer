import { DurableObject, WorkerEntrypoint } from "cloudflare:workers"
import assert from "node:assert/strict"
import { Files } from "@cloudflare/sandbox"

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000

export abstract class MeridianProfiles<Env = unknown> extends WorkerEntrypoint<Env> {
	abstract load(): Promise<{ id: string; oauthToken: string }[]>
}

export class Meridian extends DurableObject<unknown> {
	private container: Container
	private prepared = false
	private preparation = Promise.resolve()

	constructor(ctx: DurableObjectState, env: unknown) {
		super(ctx, env)
		assert(ctx.container)
		this.container = ctx.container
		ctx.blockConcurrencyWhile(async () => {
			if (this.container.running)
				await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS)
		})
	}

	refreshProfiles() {
		return this.prepare(true)
	}

	async fetch(request: Request) {
		await this.prepare()
		return this.container.getTcpPort(3456).fetch(request)
	}

	private prepare(refresh = false) {
		const ready = this.preparation.then(async () => {
			const container = this.container
			if (!container.running) {
				this.prepared = false
				container.start({ enableInternet: true })
				await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS)
			}
			if (this.prepared && !refresh) return
			const files = new Files(container)
			const profiles = await (
				this.ctx.exports as { MeridianProfiles: Pick<MeridianProfiles, "load"> }
			).MeridianProfiles.load()
			await files.writeFile("/meridian/profiles.next.json", JSON.stringify(profiles))
			await files.rename("/meridian/profiles.next.json", "/meridian/profiles.json")
			if (!this.prepared) {
				// /health checks default-profile auth; startup only needs the HTTP listener.
				const liveness = await container.exec([
					"curl",
					"--fail",
					"--silent",
					"--output",
					"/dev/null",
					"--retry",
					"30",
					"--retry-connrefused",
					"--retry-delay",
					"1",
					"--max-time",
					"2",
					"http://127.0.0.1:3456/livez",
				])
				assert.equal(
					await liveness.exitCode,
					0,
					"Meridian HTTP server did not become available",
				)
				this.prepared = true
			}
		})
		// A failed publication rejects its caller without poisoning subsequent refreshes.
		this.preparation = ready.catch(() => {})
		return ready
	}
}
