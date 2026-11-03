import { configDefaults } from "vitest/config"
import type { InlineConfig } from "vitest/node"

// Global git isolation for every test worker. Each package's vitest config imports
// this module for the test taxonomy, so this body runs in the main vitest process at
// config-load — before workers fork — and the forked workers inherit process.env.
// Keeps every child_process git spawn off the contributor's ~/.gitconfig +
// /etc/gitconfig. Without it, commits route through
// whatever signing program is configured (1Password's op-ssh-sign), which serializes
// requests under parallel test load and turns sub-second commits into multi-second
// timeouts.
process.env.GIT_CONFIG_GLOBAL = "/dev/null"
process.env.GIT_CONFIG_SYSTEM = "/dev/null"
process.env.GIT_TERMINAL_PROMPT = "0"

// Test taxonomy. The filename declares what the config can't infer: a unit test's
// runtime, or an integration test's lane. TESTING.md's "Placement & Tiers" owns the
// tiers, each lane's basket and the filename table; the configs below select files.
//
// The unmarked unit name claims the default runtime: bare `*.test.ts(x)` runs
// in plain node, in every package. `.browser.` is one marked exception — for a
// unit test whose subject is browser-coupled (window.ENV at module scope,
// localStorage, browser-only guards, DOM rendering). An unmarked
// browser-coupled test still runs (in node) and fails
// loud there, so misplacement self-reports instead of silently not running.
//
// Because every integration test is qualified, each config's include is precise
// and no cross-excludes between integration variants are needed. unitTestExclude
// drops ONLY the integration variants (they share the `.integration.test.`
// infix) — deliberately NOT the browser-unit variant: only a package that
// actually runs a browser project may pair unitTestExclude with
// browserUnitTestInclude to exclude it from its node project. Everywhere else a
// `.browser.`-marked file stays in the node include and fails loud in node, so
// BOTH misplacement directions self-report: a bare browser-coupled test, and a
// browser-marked test in a package with no browser project.

export const unitTestInclude = ["**/*.test.ts", "**/*.test.tsx"]

export const browserUnitTestInclude = ["**/*.browser.test.ts", "**/*.browser.test.tsx"]

// These bounds include real database and Worker setup plus remote provider waits.
export const platformIntegrationTestConfig = {
	fileParallelism: true,
	hookTimeout: 300_000,
	testTimeout: 120_000,
} satisfies InlineConfig

export const basicIntegrationTestConfig = {
	include: ["**/*.basic.integration.test.ts", "**/*.basic.integration.test.tsx"],
} satisfies InlineConfig

const polarPollingTestConfig = {
	// Polar Sandbox allows 100 requests per minute per organization; beyond that a request gets
	// a 429 and fails. Every provider poll in these lanes inherits this interval, so each costs
	// 12 requests per minute. Lanes composing this policy share that budget when they run
	// together (root `test:integration` runs remote and polar at once): their maxWorkers polling
	// files combined, plus `checkSlateBilling`'s Customer State reads, must stay under it.
	expect: { poll: { interval: 5_000 } },
	maxWorkers: 3,
} satisfies InlineConfig

export const polarIntegrationTestConfig = {
	...polarPollingTestConfig,
	include: ["**/*.polar.integration.test.ts", "**/*.polar.integration.test.tsx"],
} satisfies InlineConfig

export const remoteIntegrationTestConfig = {
	...polarPollingTestConfig,
	include: ["**/*.remote.integration.test.ts", "**/*.remote.integration.test.tsx"],
} satisfies InlineConfig

export const dopplerWritesIntegrationTestConfig = {
	include: [
		"**/*.doppler-writes.integration.test.ts",
		"**/*.doppler-writes.integration.test.tsx",
	],
} satisfies InlineConfig

export const polarWebhooksIntegrationTestConfig = {
	...polarPollingTestConfig,
	include: [
		"**/*.polar-webhooks.integration.test.ts",
		"**/*.polar-webhooks.integration.test.tsx",
	],
} satisfies InlineConfig

export const browserIntegrationTestConfig = {
	include: ["**/*.browser.integration.test.ts", "**/*.browser.integration.test.tsx"],
} satisfies InlineConfig

export const unitTestExclude = [
	...configDefaults.exclude,
	"**/*.integration.test.ts",
	"**/*.integration.test.tsx",
]
