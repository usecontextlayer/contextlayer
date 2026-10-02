import { configDefaults } from "vitest/config"

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

// Test taxonomy. The filename declares what the config can't infer, along two
// orthogonal axes: the RUNTIME (node or a real chromium) and the TIER
// (unit = hermetic + runs on CI vs
// integration = needs a real local prerequisite, opt-in only):
//
//   *.test.ts(x)                    → unit, node       → `test`
//   *.browser.test.ts(x)            → unit, chromium   → `test`
//   *.node.integration.test.ts(x)   → node + service   → `test:integration:node`
//   *.browser.integration.test.ts(x) → chromium + service → `test:integration:browser`
//   *.claude.integration.test.ts(x) → real claude      → `test:integration:claude`
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

export const nodeIntegrationTestInclude = [
	"**/*.node.integration.test.ts",
	"**/*.node.integration.test.tsx",
]

export const browserIntegrationTestInclude = [
	"**/*.browser.integration.test.ts",
	"**/*.browser.integration.test.tsx",
]

export const claudeIntegrationTestInclude = [
	"**/*.claude.integration.test.ts",
	"**/*.claude.integration.test.tsx",
]

export const unitTestExclude = [
	...configDefaults.exclude,
	"**/*.integration.test.ts",
	"**/*.integration.test.tsx",
]
