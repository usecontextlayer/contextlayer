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

// Test taxonomy. The filename declares what the config can't infer. Unit tests
// (hermetic, run on CI) are marked by RUNTIME: node or a real chromium.
// Integration tests (need real local prerequisites, opt-in only) are marked by
// LANE: one basket of capabilities, run as its own vitest invocation so its
// config can bound how many of its files run at once.
//
//   *.test.ts(x)                            → unit, node             → `test`
//   *.browser.test.ts(x)                    → unit, chromium         → `test`
//   *.basic.integration.test.ts(x)          → services + harness     → `test:integration:basic`
//   *.remote.integration.test.ts(x)         → remote Cloudflare     → `test:integration:remote`
//   *.polar.integration.test.ts(x)          → basic + polar api      → `test:integration:polar`
//   *.doppler.integration.test.ts(x)        → basic + vault writes   → `test:integration:doppler` (opt-in)
//   *.polar-webhooks.integration.test.ts(x) → polar relay devenv     → `test:integration:polar-webhooks` (opt-in)
//   *.browser.integration.test.ts(x)        → chromium + service     → `test:integration:browser`
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

export const basicIntegrationTestInclude = [
	"**/*.basic.integration.test.ts",
	"**/*.basic.integration.test.tsx",
]

export const remoteIntegrationTestInclude = [
	"**/*.remote.integration.test.ts",
	"**/*.remote.integration.test.tsx",
]

export const polarIntegrationTestInclude = [
	"**/*.polar.integration.test.ts",
	"**/*.polar.integration.test.tsx",
]

export const dopplerIntegrationTestInclude = [
	"**/*.doppler.integration.test.ts",
	"**/*.doppler.integration.test.tsx",
]

export const polarWebhooksIntegrationTestInclude = [
	"**/*.polar-webhooks.integration.test.ts",
	"**/*.polar-webhooks.integration.test.tsx",
]

export const browserIntegrationTestInclude = [
	"**/*.browser.integration.test.ts",
	"**/*.browser.integration.test.tsx",
]

export const platformIntegrationTestConfig = {
	fileParallelism: true,
	hookTimeout: 300_000,
	testTimeout: 120_000,
} satisfies InlineConfig

export const basicIntegrationTestConfig = {
	include: basicIntegrationTestInclude,
	provide: { containerWorkers: [] },
} satisfies InlineConfig

const polarPollingTestConfig = {
	// Polar Sandbox allows 100 requests per minute per organization and answers anything beyond
	// with a 429, which the SDK does not retry. Every provider poll in these lanes inherits this
	// interval, so each costs 12 requests per minute; maxWorkers polling files at once, plus the
	// billing gate's background reads from every lane, must stay under the limit.
	expect: { poll: { interval: 5_000 } },
	maxWorkers: 3,
} satisfies InlineConfig

export const polarIntegrationTestConfig = {
	...polarPollingTestConfig,
	include: polarIntegrationTestInclude,
	provide: { containerWorkers: [] },
} satisfies InlineConfig

export const remoteIntegrationTestConfig = {
	...polarPollingTestConfig,
	include: remoteIntegrationTestInclude,
	provide: { containerWorkers: ["build", "platform"] },
} satisfies InlineConfig

export const dopplerIntegrationTestConfig = {
	include: dopplerIntegrationTestInclude,
	provide: { containerWorkers: ["build", "platform"] },
} satisfies InlineConfig

export const polarWebhooksIntegrationTestConfig = {
	...polarPollingTestConfig,
	include: polarWebhooksIntegrationTestInclude,
	provide: { containerWorkers: [] },
} satisfies InlineConfig

export const unitTestExclude = [
	...configDefaults.exclude,
	"**/*.integration.test.ts",
	"**/*.integration.test.tsx",
]
