import { defineConfig } from "tsdown"

export default defineConfig({
	clean: true,
	dts: true,
	// Five entries, five package subpaths. `index` is the barrel (drags `hono` via
	// the auth middleware); `ctx-machine-token` is a deliberately barrel-free entry
	// (the machine-token mint primitive) exported at
	// `@usecontextlayer/shared/ctx-machine-token` so the CLIs can value-import the
	// mint without pulling `hono`/`jose` into their bundles; `ctx-token-provider`
	// is barrel-free for the same reason on the browser side — slate value-imports
	// `ctxAuthHeaders` into its client bundle, which must never carry the barrel's
	// hono/jose graph; `sentry-event-cap` is
	// barrel-free for stricter reasons (see its header); `testing` is the fixture-JWKS auth kit —
	// a root-level file fenced off the barrel so the production surface never carries it.
	// Object form → deterministic output
	// basenames (`dist/<key>.mjs`).
	entry: {
		"ctx-machine-token": "lib/ctx-machine-token.ts",
		"ctx-token-provider": "lib/ctx-token-provider.ts",
		index: "index.ts",
		"sentry-event-cap": "lib/sentry-event-cap.ts",
		testing: "testing.ts",
	},
	format: ["esm"],
	minify: false,
	outDir: "dist",
	platform: "node",
	sourcemap: false,
})
