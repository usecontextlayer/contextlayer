import { DurableObject } from "cloudflare:workers"
import assert from "node:assert/strict"
import { Files } from "@cloudflare/sandbox"
import type { PlatformBindings } from "@/env"
import { loadMeridianProfiles } from "@/secrets.server"

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000

export class Meridian extends DurableObject<PlatformBindings> {
	private container: Container
	private prepared = false
	private preparation = Promise.resolve()

	constructor(ctx: DurableObjectState, env: PlatformBindings) {
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
			const profiles = await loadMeridianProfiles(this.env)
			await files.writeFile("/meridian/profiles.next.json", JSON.stringify(profiles))
			await files.rename("/meridian/profiles.next.json", "/meridian/profiles.json")
			if (!this.prepared) {
				const health = await container.exec([
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
					"http://127.0.0.1:3456/health",
				])
				assert.equal(await health.exitCode, 0, "Meridian did not become ready")
				this.prepared = true
			}
		})
		// A failed publication rejects its caller without poisoning subsequent refreshes.
		this.preparation = ready.catch(() => {})
		return ready
	}
}
