import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test as base } from "@tests/database"
import {
	readDevEnvCommandEnv,
	readDevEnvIdentity,
	readDevEnvServiceEnv,
	readDevEnvWebEnv,
} from "@usecontextlayer/dev-env/dev-env"
import { readDevEnvPorts } from "@usecontextlayer/dev-env/ports"
import seed from "@usecontextlayer/dev-env/seed.json" with { type: "json" }
import { signInWeb } from "@usecontextlayer/dev-env/web"
import type { SlateProvisioning } from "@usecontextlayer/shared/slate-provisioning"
import type { PlatformEnv } from "@/context"
import { createPlatformDb } from "@/database"
import { parsePlatformEnv } from "@/env"
import type { Provisioning } from "@/provisioning.server"
// biome-ignore lint/style/noRestrictedImports: shared Worker fixtures live outside the package
import * as workerFixtures from "../../../vitest.workers.ts"

const root = resolve(import.meta.dirname, "../../..")
const webRoot = resolve(root, "../web")

export const test = base
	.extend("addresses", { scope: "file" }, () => readDevEnvPorts(root))
	.extend("webEnv", { scope: "file" }, ({ addresses }) =>
		readDevEnvWebEnv(webRoot, addresses),
	)
	.extend("serviceEnv", { scope: "file" }, ({ addresses, webEnv }) =>
		readDevEnvServiceEnv(root, webEnv, addresses),
	)
	.extend("webSession", async ({ webEnv }, { onCleanup }) => {
		const session = await signInWeb({
			baseURL: webEnv.BETTER_AUTH_URL,
			email: seed.web.user.email,
			password: seed.web.credentials.password,
		})
		onCleanup(async () => {
			await session.client.signOut()
		})
		return session
	})
	.extend("commandEnv", { scope: "file" }, ({ addresses }) =>
		readDevEnvCommandEnv(root, addresses),
	)
	.extend("identity", { scope: "file" }, ({ commandEnv }) =>
		readDevEnvIdentity(commandEnv),
	)
	.extend("organization", { scope: "file" }, ({ identity }) => {
		const organization = identity.organizations.find(
			(item) => item.id === seed.web.organization.id,
		)
		assert(
			organization,
			"Sign into the initialized DevEnv account with pnpm dev:ctx login.",
		)
		return organization
	})
	// biome-ignore lint/correctness/noEmptyPattern: Vitest identifies fixture dependencies by destructuring.
	.extend("directory", async ({}, { onCleanup }) => {
		const directory = await mkdtemp(join(tmpdir(), "platform-test-"))
		onCleanup(() => rm(directory, { force: true, recursive: true }))
		return directory
	})
	.extend("devEnvDb", async ({ serviceEnv }, { onCleanup }) => {
		const db = createPlatformDb(serviceEnv.platformEnv.CTX_PLATFORM_DATABASE_URL)
		onCleanup(() => db.destroy())
		return db
	})
	.extend("platformEnv", { scope: "file" }, ({ databases, serviceEnv }) =>
		parsePlatformEnv({
			...serviceEnv.platformEnv,
			CTX_PLATFORM_DATABASE_URL: databases.urls.ctx_platform_test,
		}),
	)
	.extend(
		"platformWorkers",
		{ scope: "file" },
		({ platformEnv }): workerFixtures.Workers => [
			{ ...workerFixtures.platformWorkerConfig, secrets: platformEnv },
			workerFixtures.buildWorkerConfig,
		],
	)
	.extend("workers", ({ platformWorkers }) => platformWorkers)
	.extend("platform", async ({ platformEnv: env, workers, harness }) => {
		const origin = (await harness.listen()).url.origin
		if (
			workers.some(
				(worker) =>
					"configPath" in worker &&
					worker.configPath?.toString() ===
						workerFixtures.dispatcherWorkerConfig.configPath.toString(),
			)
		) {
			await harness.update((current) => ({
				...current,
				workers: current.workers.map((worker) =>
					"configPath" in worker &&
					worker.configPath?.toString() ===
						workerFixtures.dispatcherWorkerConfig.configPath.toString()
						? { ...worker, secrets: { ...worker.secrets, CTX_PLATFORM_URL: origin } }
						: worker,
				),
			}))
		}
		return { env, harness, origin, worker: harness.getWorker<PlatformEnv["Bindings"]>() }
	})
	.extend("cliEnv", ({ commandEnv, platform }) => ({
		...commandEnv,
		CTX_PLATFORM_URL: platform.origin,
	}))
	.extend("buildWorker", ({ platform }) =>
		platform.harness.getWorker<{
			MEMBER_PROVISIONING: Workflow<SlateProvisioning>
			PROVISIONING: Service<Provisioning>
		}>("contextlayer-build-test"),
	)

export const dispatcherTest = test
	.extend(
		"workers",
		({ platformWorkers, serviceEnv }): workerFixtures.Workers => [
			...platformWorkers,
			{
				...workerFixtures.dispatcherWorkerConfig,
				secrets: {
					CTX_PLATFORM_URL: serviceEnv.addresses.CTX_PLATFORM_URL.origin,
					CTX_VIEWER_AUTH_URL: serviceEnv.addresses.CTX_VIEWER_AUTH_URL.origin,
					POLAR_ACCESS_TOKEN: serviceEnv.polarEnv.POLAR_ACCESS_TOKEN,
					POLAR_ENVIRONMENT: serviceEnv.polarEnv.POLAR_ENVIRONMENT,
				},
			},
		],
	)
	.extend("dispatcher", ({ platform }) =>
		platform.harness.getWorker("contextlayer-dispatcher-test"),
	)
