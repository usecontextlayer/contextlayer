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
import { devEnvOrganizationSlug } from "@usecontextlayer/dev-env/env"
import { readDevEnvPorts } from "@usecontextlayer/dev-env/ports"
import { signInWeb } from "@usecontextlayer/dev-env/web"
import type { SlateProvisioning } from "@usecontextlayer/shared/slate-provisioning"
import type { HostedExecution } from "@usecontextlayer/shared/tools-worker"
import type { TestHarnessOptions } from "wrangler"
import type { PlatformEnv } from "@/context"
import { createPlatformDb } from "@/database"
import { parsePlatformEnv } from "@/env"
import type { Provisioning } from "@/provisioning.server"

const root = resolve(import.meta.dirname, "../../..")
const webRoot = resolve(root, "../web")
const dispatcherConfig = new URL("../../dispatcher/wrangler.jsonc", import.meta.url)

type WorkerConfig = Pick<
	Extract<TestHarnessOptions["workers"][number], { configPath: unknown }>,
	"configPath" | "env" | "prebuiltWorkerDir" | "secrets"
>

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
			email: webEnv.CTX_DEV_USER_EMAIL,
			password: webEnv.CTX_DEV_USER_PASSWORD,
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
			(item) => item.slug === devEnvOrganizationSlug,
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
	.extend("platformEnv", ({ databases, serviceEnv }) =>
		parsePlatformEnv({
			...serviceEnv.platformEnv,
			CTX_PLATFORM_DATABASE_URL: databases.urls.ctx_platform_test,
		}),
	)
	.extend("workers", ({ platformEnv }): WorkerConfig[] => [
		{
			configPath: new URL("../wrangler.jsonc", import.meta.url),
			env: "test",
			prebuiltWorkerDir: new URL("../build/server", import.meta.url),
			secrets: platformEnv,
		},
		{
			configPath: new URL("../../build/wrangler.jsonc", import.meta.url),
			env: "test",
		},
	])
	.extend("platform", async ({ platformEnv: env, workers, harness }) => {
		const origin = (await harness.listen()).url.origin
		if (
			workers.some(
				(worker) =>
					"configPath" in worker &&
					worker.configPath?.toString() === dispatcherConfig.toString(),
			)
		) {
			await harness.update((current) => ({
				...current,
				workers: current.workers.map((worker) =>
					"configPath" in worker &&
					worker.configPath?.toString() === dispatcherConfig.toString()
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
	.extend("provisioning", ({ platform }) => ({
		harness: platform.harness,
		worker: platform.harness.getWorker<{
			PROVISIONING: Service<Provisioning>
			MEMBER_PROVISIONING: Workflow<SlateProvisioning>
		}>("contextlayer-build-test"),
	}))

export const dispatcherTest = test
	.extend("workers", ({ workers, serviceEnv }): WorkerConfig[] => [
		...workers,
		{
			configPath: dispatcherConfig,
			env: "test",
			prebuiltWorkerDir: new URL("../../dispatcher/dist", import.meta.url),
			secrets: {
				CTX_PLATFORM_URL: serviceEnv.addresses.CTX_PLATFORM_URL.origin,
				CTX_VIEWER_AUTH_URL: serviceEnv.addresses.CTX_VIEWER_AUTH_URL.origin,
				POLAR_ACCESS_TOKEN: serviceEnv.polarEnv.POLAR_ACCESS_TOKEN,
				POLAR_ENVIRONMENT: serviceEnv.polarEnv.POLAR_ENVIRONMENT,
			},
		},
	])
	.extend("dispatcher", ({ platform }) => ({
		harness: platform.harness,
		worker: platform.harness.getWorker<{ EXECUTION: HostedExecution }>(
			"contextlayer-dispatcher-test",
		),
	}))

export const executionTest = test
	.extend("workers", ({ workers }): WorkerConfig[] => [
		...workers,
		{
			configPath: new URL("./fixtures/execution/wrangler.jsonc", import.meta.url),
		},
	])
	.extend("execution", ({ platform }) => ({
		worker: platform.harness.getWorker("contextlayer-execution-caller-test"),
	}))
