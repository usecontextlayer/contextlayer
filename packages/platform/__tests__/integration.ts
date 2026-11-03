import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
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
const execFile = promisify(execFileCallback)
// Introspection uses the named Worker exports; the generated default handler stays opaque.
type PlatformWorkerModule = Omit<typeof import("@/server"), "default"> & {
	default: object
}

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
		"baseWorkerConfigs",
		{ scope: "file" },
		({ platformEnv }): workerFixtures.WorkerConfigs => [
			{ ...workerFixtures.platformWorkerConfig, secrets: platformEnv },
			workerFixtures.buildWorkerConfig,
		],
	)
	.extend("workers", ({ baseWorkerConfigs }) => baseWorkerConfigs)
	.extend("platform", async ({ platformEnv: env, harness }) => {
		const origin = (await harness.listen()).url.origin
		return {
			env,
			harness,
			origin,
			worker: harness.getWorker<PlatformEnv["Bindings"], PlatformWorkerModule>(),
		}
	})
	.extend("cliEnv", ({ commandEnv, platform }) => ({
		...commandEnv,
		CTX_PLATFORM_URL: platform.origin,
	}))
	.extend("git", ({ cliEnv, directory, platform }) => {
		const cli = join(import.meta.dirname, "../../cli/dist/cli.mjs")
		return (...args: string[]) =>
			execFile(
				"git",
				["-c", `credential.${platform.origin}/git.helper=${cli} git-credential`, ...args],
				{ cwd: directory, env: { ...process.env, ...cliEnv } },
			)
	})
	.extend("buildWorker", ({ platform }) =>
		platform.harness.getWorker<{
			MEMBER_PROVISIONING: Workflow<SlateProvisioning>
			PROVISIONING: Service<Provisioning>
		}>("contextlayer-build-test"),
	)

export const dispatcherTest = test
	// Keep the named base: extending file-scoped `workers` from itself omits Dispatcher.
	.extend(
		"workers",
		({ baseWorkerConfigs, serviceEnv }): workerFixtures.WorkerConfigs => [
			...baseWorkerConfigs,
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
	.extend("platform", async ({ platform }) => {
		await platform.harness.update((current) => ({
			...current,
			workers: current.workers.map((worker) =>
				"configPath" in worker &&
				worker.configPath?.toString() ===
					workerFixtures.dispatcherWorkerConfig.configPath.toString()
					? {
							...worker,
							secrets: { ...worker.secrets, CTX_PLATFORM_URL: platform.origin },
						}
					: worker,
			),
		}))
		return platform
	})
	.extend("dispatcher", ({ platform }) =>
		platform.harness.getWorker("contextlayer-dispatcher-test"),
	)
