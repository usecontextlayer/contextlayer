import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { prepareLocalAgentRun } from "@/local-runtime/preparation"
import { readLocalSnapshot } from "@/local-source"

const directories: string[] = []
afterEach(async () => {
	vi.unstubAllEnvs()
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	)
})

async function checkout() {
	const directory = await mkdtemp(join(tmpdir(), "ctx-local-source-"))
	directories.push(directory)
	return directory
}

test("an empty checkout prepares without a package, Git remote, or login", async () => {
	const snapshot = await readLocalSnapshot(await checkout())
	expect(snapshot).toMatchObject({
		agents: {},
		configuration: { connections: {}, databases: {}, secrets: {} },
		gateway: null,
		source: "working-tree",
	})
	expect(snapshot.scope).toMatch(/^ctx-local-resources-[0-9a-f]{16}$/)
})

test("current instructions and native schedules enter one startup snapshot; jobs keep scoped references without secret values", async () => {
	const directory = await checkout()
	await mkdir(join(directory, "agents/reporter/schedules"), { recursive: true })
	await mkdir(join(directory, "app"))
	await writeFile(
		join(directory, "app/slate.json"),
		JSON.stringify({
			connections: {},
			databases: { notes: { mode: "owner" } },
			secrets: { APP_SECRET: { mode: "owner" } },
		}),
	)
	await writeFile(
		join(directory, "agents/reporter/slate.json"),
		JSON.stringify({
			connections: {},
			databases: { notes: { mode: "owner" } },
			secrets: { REPORT_SECRET: { mode: "viewer" } },
		}),
	)
	await writeFile(
		join(directory, "agents/reporter/instructions.md"),
		"Read notes and report.",
	)
	await writeFile(
		join(directory, "agents/reporter/schedules/daily.md"),
		"---\ncron: '0 7 * * 1-5'\n---\nSummarize today's notes.\n",
	)
	vi.stubEnv("REPORT_SECRET", "developer-selected-value")
	const snapshot = await readLocalSnapshot(directory)
	expect(snapshot.agents.reporter?.schedules).toEqual({
		daily: "---\ncron: '0 7 * * 1-5'\n---\nSummarize today's notes.\n",
	})
	const prepared = prepareLocalAgentRun(snapshot, "reporter", "Run now")
	expect(prepared.allowed).toBe(true)
	if (!prepared.allowed) throw new Error(prepared.reason)
	expect(prepared.run).toMatchObject({
		actor: { type: "app" },
		agent: {
			commit: "working-tree",
			instructions: "Read notes and report.",
			name: "reporter",
		},
		databases: { notes: { instance_name: "notes" } },
		prompt: "Run now",
		secrets: { REPORT_SECRET: { ref: "REPORT_SECRET" } },
		slateId: snapshot.scope,
	})
	expect(prepared.run.secrets).not.toHaveProperty("APP_SECRET")
	expect(JSON.stringify(prepared.run)).not.toContain("developer-selected-value")
	await writeFile(
		join(directory, "agents/reporter/instructions.md"),
		"New uncommitted instructions.",
	)
	expect(snapshot.agents.reporter?.instructions).toBe("Read notes and report.")
	expect((await readLocalSnapshot(directory)).agents.reporter?.instructions).toBe(
		"New uncommitted instructions.",
	)
	vi.stubEnv("REPORT_SECRET", undefined)
	expect(
		prepareLocalAgentRun(await readLocalSnapshot(directory), "reporter", "Run now"),
	).toEqual({ allowed: false, name: "REPORT_SECRET", reason: "secret-required" })
	await rm(join(directory, "agents/reporter/instructions.md"))
	expect(
		prepareLocalAgentRun(await readLocalSnapshot(directory), "reporter", "Run now"),
	).toEqual({ allowed: false, reason: "agent-definition-missing" })
})
