import assert from "node:assert/strict"
import type { Command } from "commander"
import { HttpMethod, OpenAPIClientAxios, type Parameters } from "openapi-client-axios"
import { z } from "zod"
import { getAccessToken, LoginRequiredError, MissingLoginError } from "@/auth"
import { env } from "@/env"

const inlineJsonSchema = z
	.string()
	.transform((value, context) => {
		try {
			return JSON.parse(value) as unknown
		} catch {
			context.addIssue({ code: "custom", message: "Expected inline JSON" })
			return z.NEVER
		}
	})
	.pipe(z.json())
const rootOptionsSchema = z.object({ apiUrl: z.url().optional() })

const optionsSchema = z.object({
	json: inlineJsonSchema.optional(),
	params: inlineJsonSchema.pipe(z.record(z.string(), z.json())).optional(),
})
const apiHelp =
	"\nDiscovery requires a reachable API, but no login. Operation IDs and descriptions come from its OpenAPI document.\n\nCalls reuse the selected saved login and refresh it when needed. Public operations can run without login.\n\nInputs are inline JSON only; no file, @, or stdin expansion. Responses are JSON containing status, statusText, headers, and data. HTTP 4xx/5xx exit 1; other HTTP responses exit 0. Exit status follows HTTP status, not domain outcomes. Failures without an operation response go to stderr and exit nonzero."

export function addApiCommand(program: Command) {
	const apiCommand = program
		.command("api")
		.description("Discover and invoke the selected stack's live OpenAPI operations")
		.addHelpText("after", apiHelp)
	program.hook("preSubcommand", async (_parent, command) => {
		if (command !== apiCommand) return
		try {
			const { apiUrl } = rootOptionsSchema.parse(program.opts())
			const api = new OpenAPIClientAxios({
				definition: new URL("/api/openapi.json", apiUrl ?? env.CTX_PLATFORM_URL).href,
				...(apiUrl ? { withServer: { url: new URL("/api", apiUrl).href } } : {}),
			})
			const client = await api.init()
			for (const operation of api.getOperations()) {
				const operationId = z.string().parse(operation.operationId)
				const invoke = client.paths[operation.path]?.[operation.method]
				assert(invoke)
				apiCommand
					.command(operationId)
					.description(operation.summary ?? operationId)
					.addHelpText("after", `\n${operation.description ?? ""}\n${apiHelp}`)
					.option(
						"--params <JSON>",
						"Inline JSON object of API parameter names and values",
					)
					.option(
						"--json <JSON>",
						"Complete inline JSON request body; omitted means no body",
					)
					.option(
						"--describe",
						"Print this operation's OpenAPI document as JSON without invoking it; preserve schema references",
					)
					.action(async (options, invoked: Command) => {
						try {
							if (options.describe) {
								const pathItem = api.document.paths?.[operation.path]
								assert(pathItem)
								const methods = new Set<string>(Object.values(HttpMethod))
								console.log(
									JSON.stringify(
										{
											...api.document,
											paths: {
												[operation.path]: Object.fromEntries(
													Object.entries(pathItem).filter(
														([key]) => key === operation.method || !methods.has(key),
													),
												),
											},
										},
										null,
										2,
									),
								)
								return
							}
							const parsedOptions = optionsSchema.parse(options)
							const security = operation.security ?? []
							const acceptsBearerAuth = security.some((requirement) =>
								Object.keys(requirement).some((name) => {
									const scheme = api.definition.components?.securitySchemes?.[name]
									return (
										scheme &&
										"type" in scheme &&
										scheme.type === "http" &&
										scheme.scheme === "bearer"
									)
								}),
							)
							let accessToken: string | undefined
							if (acceptsBearerAuth) {
								try {
									accessToken = await getAccessToken(env)
								} catch (error) {
									const allowsAnonymousAccess = security.some(
										(requirement) => Object.keys(requirement).length === 0,
									)
									if (!(allowsAnonymousAccess && error instanceof MissingLoginError))
										throw error
								}
							}
							const { status, statusText, headers, data } = await invoke(
								parsedOptions.params as Parameters | undefined,
								// Axios accepts JSON text; retaining it preserves string primitives.
								options.json,
								{
									headers: {
										...(options.json !== undefined
											? { "Content-Type": "application/json" }
											: {}),
										...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
									},
									validateStatus: () => true,
								},
							)
							console.log(JSON.stringify({ data, headers, status, statusText }))
							if (status >= 400 && status < 600) process.exitCode = 1
						} catch (error) {
							if (error instanceof LoginRequiredError) throw error
							invoked.error(error instanceof Error ? error.message : String(error))
						}
					})
			}
		} catch (error) {
			apiCommand.error(error instanceof Error ? error.message : String(error))
		}
	})
}
