import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resourcesForConsumer } from "@usecontextlayer/shared/declaration"
import type { LocalResourceConfiguration } from "@usecontextlayer/shared/slate-resources"
import { afterEach, expect, expectTypeOf, test, vi } from "vitest"
import * as auth from "@/auth"
import { prepareLocalResourceConfiguration, saveLocalConnection } from "@/resources"
import { readLocalResources } from "@/slate"
import { getLocalResourcesBindings } from "@/vite"

const directories: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	)
})

async function createCheckout() {
	const directory = await mkdtemp(join(tmpdir(), "ctx-local-resources-"))
	directories.push(directory)
	await mkdir(join(directory, "app"))
	await mkdir(join(directory, "agents/summary"), { recursive: true })
	await writeFile(
		join(directory, "app/slate.json"),
		JSON.stringify({
			connections: { mail: { mode: "viewer", toolkit: "gmail" } },
			databases: { reports: { mode: "owner" } },
			secrets: { CTX_LOCAL_TEST_SECRET: { mode: "owner" } },
		}),
	)
	await writeFile(
		join(directory, "agents/summary/slate.json"),
		JSON.stringify({
			connections: {
				mail: { mode: "viewer", toolkit: "gmail" },
				repository: { mode: "owner", toolkit: "github" },
			},
			databases: { reports: { mode: "owner" } },
			secrets: { CTX_LOCAL_TEST_SECRET: { mode: "owner" } },
		}),
	)
	return directory
}

test("assembles local configuration before consumer selection without Git, credentials, or platform", async () => {
	const directory = await createCheckout()
	vi.stubEnv("CTX_LOCAL_TEST_SECRET", "local-only-value")
	const configuration = await prepareLocalResourceConfiguration(directory)
	const app = resourcesForConsumer(configuration, { type: "app" })
	const agent = resourcesForConsumer(configuration, { name: "summary", type: "agent" })
	expectTypeOf(app).toEqualTypeOf<LocalResourceConfiguration>()
	expect(Object.keys(app.connections)).toEqual(["mail"])
	expect(Object.keys(agent.connections)).toEqual(["mail", "repository"])
	expect(app.connections.mail?.account_id).toBeNull()
	expect(agent.connections.repository?.account_id).toBeNull()
	expect(app.secrets.CTX_LOCAL_TEST_SECRET?.value).toBe("local-only-value")
	expect(agent.databases.reports?.instance_name).toBe("reports")
	expect(app.databases.reports).toEqual(agent.databases.reports)
	await expect(
		readFile(join(directory, ".contextlayer/connections.json")),
	).rejects.toMatchObject({ code: "ENOENT" })
})

test("preserves saved assignments and reads only the given checkout's current declarations", async () => {
	const directory = await createCheckout()
	const other = await createCheckout()
	vi.stubEnv("CTX_LOCAL_TEST_SECRET", undefined)
	await saveLocalConnection("mail", "ca_mail", directory)
	await saveLocalConnection("repository", "ca_git", directory)
	await saveLocalConnection("mail", "ca_replacement", directory)
	expect(
		JSON.parse(await readFile(join(directory, ".contextlayer/connections.json"), "utf8")),
	).toEqual({
		mail: "ca_replacement",
		repository: "ca_git",
	})
	const configuration = await prepareLocalResourceConfiguration(directory)
	expect(configuration.connections.mail?.account_id).toBe("ca_replacement")
	expect(configuration.connections.repository?.account_id).toBe("ca_git")
	expect(configuration.secrets.CTX_LOCAL_TEST_SECRET?.value).toBeNull()
	expect(
		(await prepareLocalResourceConfiguration(other)).connections.mail?.account_id,
	).toBeNull()
	await writeFile(join(directory, "app/slate.json"), JSON.stringify({ connections: {} }))
	await rm(join(directory, "agents/summary"), { recursive: true })
	expect((await prepareLocalResourceConfiguration(directory)).connections).toEqual({})
	await mkdir(join(directory, "child"))
	expect(await prepareLocalResourceConfiguration(join(directory, "child"))).toEqual({
		connections: {},
		databases: {},
		secrets: {},
	})
})

test("rejects malformed assignments and database slugs that escape the local database root", async () => {
	const directory = await createCheckout()
	await mkdir(join(directory, ".contextlayer"))
	await writeFile(
		join(directory, ".contextlayer/connections.json"),
		JSON.stringify({ mail: { account_id: "ca_mail" } }),
	)
	await expect(prepareLocalResourceConfiguration(directory)).rejects.toThrow()
	await writeFile(join(directory, ".contextlayer/connections.json"), "{}")
	await writeFile(
		join(directory, "app/slate.json"),
		JSON.stringify({
			connections: {},
			databases: { "../outside": { mode: "owner" } },
		}),
	)
	await expect(prepareLocalResourceConfiguration(directory)).rejects.toThrow()
	await expect(stat(join(directory, ".contextlayer/databases"))).rejects.toMatchObject({
		code: "ENOENT",
	})
})

test("an empty checkout ignores the former public declaration location", async () => {
	const directory = await createCheckout()
	await rm(join(directory, "app"), { recursive: true })
	await rm(join(directory, "agents"), { recursive: true })
	await mkdir(join(directory, "public"))
	await writeFile(join(directory, "public/slate.json"), "malformed legacy declaration")
	expect(await readLocalResources(directory)).toEqual({
		connections: {},
		databases: {},
		secrets: {},
	})
})

test("agent-only checkouts retain resources without an app consumer", async () => {
	const directory = await createCheckout()
	await rm(join(directory, "app"), { recursive: true })
	const resources = await readLocalResources(directory)
	const agent = { name: "summary", type: "agent" } as const
	expect(resources).toEqual({
		connections: {
			mail: { consumers: [agent], mode: "viewer", toolkit: "gmail" },
			repository: { consumers: [agent], mode: "owner", toolkit: "github" },
		},
		databases: { reports: { consumers: [agent], mode: "owner" } },
		secrets: { CTX_LOCAL_TEST_SECRET: { consumers: [agent], mode: "owner" } },
	})
	expect(resourcesForConsumer(resources, { type: "app" })).toEqual({
		connections: {},
		databases: {},
		secrets: {},
	})
})

test.each(["empty", "agent-only"])(
	"%s source does not request app resource bindings or a login",
	async (source) => {
		const directory = await createCheckout()
		await rm(join(directory, "app"), { recursive: true })
		if (source === "empty") await rm(join(directory, "agents"), { recursive: true })
		vi.spyOn(process, "cwd").mockReturnValue(directory)
		vi.spyOn(auth, "getAccessToken").mockRejectedValue(new Error("Login unavailable"))
		expect(await getLocalResourcesBindings()).toBeUndefined()
	},
)

test("an app with local databases needs no login for connections declared only by agents", async () => {
	const directory = await createCheckout()
	await writeFile(
		join(directory, "app/slate.json"),
		JSON.stringify({ connections: {}, databases: { reports: { mode: "owner" } } }),
	)
	vi.spyOn(process, "cwd").mockReturnValue(directory)
	vi.spyOn(auth, "getAccessToken").mockRejectedValue(new Error("Login unavailable"))
	const bindings = await getLocalResourcesBindings()
	expect(bindings?.props).toBeUndefined()
	expect(bindings?.databaseProps.databases.reports?.instance_name).toBe("reports")
	expect(Object.keys(bindings?.configuration.connections ?? {})).toEqual([
		"mail",
		"repository",
	])
})

test.each(["app", "agents/summary"])(
	"a present %s requires a readable, valid declaration",
	async (source) => {
		const directory = await createCheckout()
		const declaration = join(directory, source, "slate.json")
		await rm(declaration)
		await expect(readLocalResources(directory)).rejects.toMatchObject({ code: "ENOENT" })
		await writeFile(declaration, "{")
		await expect(readLocalResources(directory)).rejects.toBeInstanceOf(SyntaxError)
		await writeFile(declaration, JSON.stringify({ connections: { mail: {} } }))
		await expect(readLocalResources(directory)).rejects.toMatchObject({
			name: "ZodError",
		})
	},
)
