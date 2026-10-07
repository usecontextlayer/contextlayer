import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LocalResourceConfiguration } from "@usecontextlayer/shared/app-resources"
import { resourcesForConsumer } from "@usecontextlayer/shared/slate"
import { afterEach, expect, expectTypeOf, test, vi } from "vitest"
import { prepareLocalResourceConfiguration, saveLocalConnection } from "@/resources"

const directories: string[] = []
afterEach(async () => {
	vi.unstubAllEnvs()
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	)
})

async function createApp() {
	const directory = await mkdtemp(join(tmpdir(), "ctx-local-resources-"))
	directories.push(directory)
	await mkdir(join(directory, "public"))
	await mkdir(join(directory, "agents/summary"), { recursive: true })
	await writeFile(
		join(directory, "public/slate.json"),
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
	const directory = await createApp()
	vi.stubEnv("CTX_LOCAL_TEST_SECRET", "local-only-value")
	await writeFile(join(directory, ".gitignore"), "node_modules/")
	const configuration = await prepareLocalResourceConfiguration(directory)
	const app = resourcesForConsumer(configuration, { type: "app" })
	const agent = resourcesForConsumer(configuration, { name: "summary", type: "agent" })
	expectTypeOf(app).toEqualTypeOf<LocalResourceConfiguration>()
	expect(Object.keys(app.connections)).toEqual(["mail"])
	expect(Object.keys(agent.connections)).toEqual(["mail", "repository"])
	expect(app.connections.mail?.connection_id).toBeNull()
	expect(agent.connections.repository?.connection_id).toBeNull()
	expect(app.secrets.CTX_LOCAL_TEST_SECRET?.value).toBe("local-only-value")
	expect(agent.databases.reports?.instance_name).toBe("reports")
	expect(app.databases.reports).toEqual(agent.databases.reports)
	expect(agent.databases.reports?.migrations).toEqual({
		journal: { entries: [] },
		migrations: {},
	})
	expect(await readFile(join(directory, ".gitignore"), "utf8")).toBe(
		"node_modules/\n/.contextlayer/\n",
	)
	await expect(
		readFile(join(directory, ".contextlayer/connections.json")),
	).rejects.toMatchObject({ code: "ENOENT" })
})

test("preserves saved choices and reads only the given app database's current declarations", async () => {
	const directory = await createApp()
	const other = await createApp()
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
	expect(configuration.connections.mail?.connection_id).toBe("ca_replacement")
	expect(configuration.connections.repository?.connection_id).toBe("ca_git")
	expect(configuration.secrets.CTX_LOCAL_TEST_SECRET?.value).toBeNull()
	expect(
		(await prepareLocalResourceConfiguration(other)).connections.mail?.connection_id,
	).toBeNull()
	await writeFile(
		join(directory, "public/slate.json"),
		JSON.stringify({ connections: {} }),
	)
	await rm(join(directory, "agents/summary"), { recursive: true })
	expect((await prepareLocalResourceConfiguration(directory)).connections).toEqual({})
	expect(await readFile(join(directory, ".gitignore"), "utf8")).toBe("/.contextlayer/\n")
	await mkdir(join(directory, "child"))
	await expect(
		prepareLocalResourceConfiguration(join(directory, "child")),
	).rejects.toMatchObject({ code: "ENOENT" })
})

test("rejects malformed bindings and database names that escape the local database root", async () => {
	const directory = await createApp()
	await mkdir(join(directory, ".contextlayer"))
	await writeFile(
		join(directory, ".contextlayer/connections.json"),
		JSON.stringify({ mail: { connection_id: "ca_mail" } }),
	)
	await expect(prepareLocalResourceConfiguration(directory)).rejects.toThrow()
	await writeFile(join(directory, ".contextlayer/connections.json"), "{}")
	await writeFile(
		join(directory, "public/slate.json"),
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
