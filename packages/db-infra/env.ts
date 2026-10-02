// db-infra is a library, not a boot boundary — the composition roots own every
// DSN and inject handles. The ONE ambient variable it reads is NODE_ENV
// (out-of-scheme, third-party convention), which gates nothing but the kysely
// error-log verbosity in `initKysely` — so this env boundary is a plain typed
// read, no schema (and no zod dependency for a package that otherwise needs none).
export const env = {
	NODE_ENV: process.env.NODE_ENV,
} as const
