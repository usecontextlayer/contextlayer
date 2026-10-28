import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { setTimeout } from "node:timers/promises"
import { createPolarCore, errors, type models } from "@polar-sh/sdk/2026-10"
import {
	createCustomers,
	getExternalCustomers,
	getStateCustomers,
} from "@polar-sh/sdk/2026-10/services/customers"
import {
	getOrganizations,
	updateOrganizations,
} from "@polar-sh/sdk/2026-10/services/organizations"
import {
	createSubscriptions,
	iterListSubscriptions,
} from "@polar-sh/sdk/2026-10/services/subscriptions"
import { initializeDatabase, seedDatabase } from "@usecontextlayer/dev-env/database"
import { readDopplerEnv } from "@usecontextlayer/dev-env/doppler"
import { readDevEnv } from "@usecontextlayer/dev-env/env"
import seed from "@usecontextlayer/dev-env/seed.json" with { type: "json" }
import { execa } from "execa"
import { z } from "zod"
// biome-ignore lint/style/noRestrictedImports: root operational scripts have no package alias.
import { seedCatalog } from "./dev-seed-catalog"

const root = resolve(import.meta.dirname, "..")
const webRoot = resolve(root, "../web")
const platformConfig = await readDopplerEnv(root, "platform", "dev")
const bootstrap = z
	.object({
		POLAR_ACCESS_TOKEN: z.string().min(1),
		POLAR_CLIPS_METER_ID: z.uuid().optional(),
		POLAR_DEVENV_UNLIMITED_PRODUCT_ID: z.uuid().optional(),
		POLAR_ENVIRONMENT: z.literal("sandbox"),
		POLAR_FREE_PRODUCT_ID: z.uuid().optional(),
		POLAR_PRO_PRODUCT_ID: z.uuid().optional(),
		POLAR_ULTRA_PRODUCT_ID: z.uuid().optional(),
	})
	.parse(platformConfig)
const { DATABASE_URL } = readDevEnv()
const polar = createPolarCore({
	accessToken: bootstrap.POLAR_ACCESS_TOKEN,
	environment: bootstrap.POLAR_ENVIRONMENT,
})
const database = new URL(DATABASE_URL)
console.log(
	`Seeding web database ${database.pathname.slice(1)} on ${database.host} and the shared Polar Sandbox baseline.`,
)
await execa("docker", ["compose", "up", "-d", "--no-recreate", "--wait", "postgres"], {
	cwd: webRoot,
	stdio: "inherit",
})
await initializeDatabase(DATABASE_URL, async () => {
	await execa("pnpm", ["db.latest", "--ci"], {
		cwd: webRoot,
		env: { DATABASE_URL, NODE_ENV: "development" },
		stdio: "inherit",
	})
})
await seedDatabase(
	DATABASE_URL,
	await readFile(resolve(webRoot, "database/dev-seed.sql"), "utf8"),
	seed,
)
const baseline = seed.web
console.log(
	`Web baseline ready: user ${baseline.user.id}, organization ${baseline.organization.id}, CLI client ${baseline.client.clientId}.`,
)
const { free, meter, unlimited } = await seedCatalog(polar, platformConfig)

for (const body of [
	{
		email: baseline.user.email,
		external_id: baseline.user.id,
		name: baseline.user.name,
		type: "individual",
	},
	{
		external_id: baseline.organization.id,
		name: baseline.organization.name,
		owner: {
			email: baseline.user.email,
			external_id: baseline.user.id,
			name: baseline.user.name,
		},
		type: "team",
	},
] satisfies models.CustomerCreate[]) {
	let customer: models.Customer
	let customerCreated = false
	try {
		customer = await getExternalCustomers(polar)(body.external_id)
	} catch (error) {
		if (!(error instanceof errors.ResourceNotFound)) throw error
		customer = await createCustomers(polar)(body)
		customerCreated = true
	}
	assert(
		customer.type === body.type && customer.organization_id === meter.organization_id,
		`Customer ${customer.id} has an incompatible type or Sandbox organization.`,
	)
	const subscriptions = await Array.fromAsync(
		iterListSubscriptions(polar)({
			active: true,
			customer_id: customer.id,
			product_id: unlimited.id,
		}),
	)
	assert(
		subscriptions.length <= 1,
		`Customer ${customer.id} has duplicate Unlimited subscriptions; operator disposition is required.`,
	)
	const subscription =
		subscriptions[0] ??
		(await createSubscriptions(polar)({
			customer_id: customer.id,
			product_id: unlimited.id,
		}))
	const deadline = Date.now() + 60_000
	while (
		!(await getStateCustomers(polar)(customer.id)).active_subscriptions.some(
			(item) => item.id === subscription.id,
		)
	) {
		assert(
			Date.now() < deadline,
			`Unlimited subscription ${subscription.id} is not yet active; rerun the seed to observe completion.`,
		)
		await setTimeout(1_000)
	}
	console.log(
		`${body.type} customer: ${customer.id} (${customerCreated ? "created" : "reused"}); Unlimited subscription: ${subscription.id} (${subscriptions.length ? "reused" : "created"}, active count: 1)`,
	)
}
const organization = await getOrganizations(polar)(meter.organization_id)
if (!organization.customer_portal_settings.subscription.update_plan)
	await updateOrganizations(polar)(organization.id, {
		customer_portal_settings: {
			...organization.customer_portal_settings,
			subscription: {
				...organization.customer_portal_settings.subscription,
				update_plan: true,
			},
		},
	})
const { stdout: secret } = await execa(
	"pnpm",
	["exec", "polar", "webhook", "listen", "--print-secret"],
	{ cwd: resolve(root, "packages/dev-env"), env: bootstrap },
)
const webhookSecret = z.string().trim().min(1).parse(secret)

async function publish(
	cwd: string,
	project: string,
	config: string,
	before: Record<string, string>,
	values: Record<string, string>,
) {
	for (const [key, value] of Object.entries(values)) {
		if (before[key] === value) continue
		const result = await execa(
			"doppler",
			[
				"secrets",
				"set",
				key,
				"--project",
				project,
				"--config",
				config,
				"--silent",
				"--no-interactive",
			],
			{ cwd, input: value, reject: false },
		)
		assert(
			result.exitCode === 0,
			`Could not publish ${key} to ${project}/${config}; rerun after resolving operator access.`,
		)
		console.log(`Published ${key} to ${project}/${config}`)
	}
	const effective = await readDopplerEnv(cwd, project, config)
	assert(
		Object.entries(values).every(([key, value]) => effective[key] === value),
		`Configuration verification failed for ${project}/${config}.`,
	)
}

await publish(root, "platform", "dev", platformConfig, {
	POLAR_ACCESS_TOKEN: bootstrap.POLAR_ACCESS_TOKEN,
	POLAR_CLIPS_METER_ID: meter.id,
	POLAR_ENVIRONMENT: "sandbox",
	POLAR_FREE_PRODUCT_ID: free.id,
	POLAR_WEBHOOK_SECRET: webhookSecret,
})
console.log("Polar baseline ready. Account configuration verified in platform/dev.")
