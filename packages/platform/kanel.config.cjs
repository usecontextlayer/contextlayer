const { makePgTsGenerator, markAsGenerated } = require("kanel")
const { makeKyselyHook } = require("kanel-kysely")

/** @type {import('kanel').ConfigV4} */
module.exports = {
	connection: process.env.DATABASE_URL,
	generators: [
		makePgTsGenerator({
			getPropertyMetadata: (property, details, _generateFor, builtin) =>
				details.name === "polar_customer_state" && property.name === "state"
					? {
							...builtin,
							typeOverride: {
								name: "models.CustomerState",
								typeImports: [
									{
										importAsType: true,
										isAbsolute: true,
										isDefault: false,
										name: "models",
										path: "@polar-sh/sdk/2026-10",
									},
								],
							},
						}
					: builtin,
			preRenderHooks: [makeKyselyHook()],
		}),
	],
	outputPath: "app/database/models",
	postRenderHooks: [markAsGenerated],
	schemaNames: ["public"],
}
