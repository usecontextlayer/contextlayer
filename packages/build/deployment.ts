export function slateDeploymentConfig(slateId: string) {
	return {
		assets: { binding: "ASSETS", directory: "./client" },
		base_dir: "./server",
		compatibility_date: "2026-10-19",
		compatibility_flags: ["nodejs_compat"],
		find_additional_modules: true,
		main: "./server/index.js",
		name: slateId,
		no_bundle: true,
		observability: { enabled: true },
		rules: [{ globs: ["**/*.js", "**/*.mjs"], type: "ESModule" }],
		upload_source_maps: false,
	}
}
