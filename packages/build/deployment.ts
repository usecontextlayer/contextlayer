export function slateDeploymentConfig(
	slateId: string,
	commit: string,
	hasServer: boolean,
) {
	return {
		assets: {
			directory: "./payload/client",
			...(hasServer ? { binding: "ASSETS" } : {}),
		},
		compatibility_date: "2026-10-19",
		compatibility_flags: ["nodejs_compat"],
		...(hasServer
			? {
					base_dir: "./payload/server",
					find_additional_modules: true,
					main: "./payload/server/index.js",
					rules: [{ globs: ["**/*.js", "**/*.mjs"], type: "ESModule" }],
				}
			: {}),
		name: slateId,
		no_bundle: true,
		observability: { enabled: true },
		tsconfig: "./tsconfig.json",
		unsafe: { metadata: { tags: [`commit:${commit}`] } },
		upload_source_maps: false,
	}
}
