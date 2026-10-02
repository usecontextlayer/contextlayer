const { makePgTsGenerator, markAsGenerated } = require("kanel")
const { makeKyselyHook } = require("kanel-kysely")

/** @type {import('kanel').ConfigV4} */
module.exports = {
	connection: process.env.DATABASE_URL,
	generators: [makePgTsGenerator({ preRenderHooks: [makeKyselyHook()] })],
	outputPath: "app/database/models",
	postRenderHooks: [markAsGenerated],
	schemaNames: ["public"],
}
