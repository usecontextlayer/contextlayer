export function slateDeploymentConfig(slateId: string) {
	return {
		assets: { binding: "ASSETS", directory: "./payload/client" },
		base_dir: "./payload/server",
		compatibility_date: "2026-10-19",
		compatibility_flags: ["nodejs_compat"],
		find_additional_modules: true,
		main: "./payload/server/index.js",
		name: slateId,
		no_bundle: true,
		observability: { enabled: true },
		rules: [{ globs: ["**/*.js", "**/*.mjs"], type: "ESModule" }],
		tsconfig: "./tsconfig.json",
		upload_source_maps: false,
	}
}
