# monorepo-mechanics

Dependency, version, and release mechanics stay coherent across the monorepo — every declaration truthful, every version single-sourced. (Written for the contextlayer monorepo and its JS workspace conventions; apply the universal parts anywhere they fit.)

## FAIL when

- **Phantom deps:** a file imports a package its own workspace `package.json` does not declare — it resolves only via hoisting or a sibling's declaration. Every import maps to a declaration in the importing package.
- **Wrong bucket:** a package imported by code that ships and runs at runtime sits in `devDependencies` — especially native deps (`microsandbox`, `@parcel/watcher`), which the bundler would otherwise inline and break. The fix is `dependencies`, not bundler-externalization patches. **The test is what must still RESOLVE after the build — and that differs by what the package SHIPS.** tsdown externalizes `dependencies`/`peerDependencies`/`optionalDependencies` and bundles the rest: a self-contained executable compiles its `workspace:*` deps into `dist`, so they are correctly `devDependencies`; a library's consumers resolve its imports, so its workspace deps are correctly runtime `dependencies`. Flag only when an import must survive into the artifact that ships: a native binary, or a dep deliberately kept external (`@sentry/node`, whose loader hooks break when inlined).
- **Coupled SDK drift:** members of an SDK family sharing one runtime registry (e.g. all `@sentry/*` behind `globalThis.__SENTRY__`) resolve to different versions anywhere in the workspace. One exact version everywhere — even when today's mismatch is harmless. (The judgment call is *which* families are runtime-coupled; independent deps may drift.)
- **Hand-maintained version literals:** an image tag, release string, or pinned default that `release.ts` already owns is introduced as an independent literal that can drift. Version-bearing constants derive from the canonical release mechanism, like everything else.
- **Manifest/lockfile drift:** `package.json` version strings change without the matching lockfile entries, or the lockfile is reconciled by jq/sed surgery instead of the package manager (`pnpm install --lockfile-only`).
- **Unexpected git mutations:** version-only helpers or unrelated tooling stage, commit, push, or tag. The operator-invoked release ladder in `scripts/release.ts` intentionally owns those Git operations; this exception does not extend to `bump`, `audit`, `verify`, `publish-list`, or dry runs.
- **Generated artifacts in source:** `.d.ts`/`.d.ts.map`/compiled output landing beside source files instead of the designated build dir. (Hand-authored declarations like `env.d.ts` are fine — judge origin, not extension.)
- **Runner inconsistency:** one context (a CI workflow, a package's scripts) mixing `pnpm run X` and `bun run X` to invoke package scripts. Direction of travel is Bun removal (node/npx/tsx) — new load-bearing bun usage needs explicit justification.

## Out of scope, deliberately

- **Image tag policy (`:latest` vs pinned):** the evidence corpus contains a direct contradiction on this, unresolved. Do not flag either direction; at most note occurrences for the operator.

## Calibration

> "phantom dep is UNACCEPTABLE"

> "okay, then everyone should be at the same version. even the harmless ones. the whole codebase should be consistently on one version"
