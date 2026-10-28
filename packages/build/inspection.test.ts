import { INSPECTION_SLATE_HEADER } from "@usecontextlayer/shared/inspection"
import { describe, expect, it } from "vitest"
import { inspectCloudflare, redactPreparationOutput } from "@/inspection"
import { redactSecrets } from "@/redaction"

it("exposes configuration without credentials and rejects unselected upstream authority", async () => {
	const slate = crypto.randomUUID()
	const env = {
		CF_TOKEN: "private-cloudflare-credential",
		CLOUDFLARE_ACCOUNT_ID: "selected-account",
		CTX_CI_WORKFLOW: "selected-workflow",
		CTX_DISPATCH_NAMESPACE: "selected-namespace",
		R2_SECRET_ACCESS_KEY: "private-r2-credential",
	}
	const request = (path: string, method = "GET") =>
		inspectCloudflare(
			env,
			new Request(`https://inspection${path}`, {
				headers: { [INSPECTION_SLATE_HEADER]: slate },
				method,
			}),
		)
	expect(await (await request("/")).json()).toEqual({
		account_id: env.CLOUDFLARE_ACCOUNT_ID,
		dispatch_namespace: env.CTX_DISPATCH_NAMESPACE,
		script_name: slate,
		workflow_name: env.CTX_CI_WORKFLOW,
	})
	for (const path of [
		"/accounts/another-account/workflows/selected-workflow/instances",
		"/accounts/selected-account/workflows/another-workflow/instances",
		`/accounts/selected-account/workers/dispatch/namespaces/selected-namespace/scripts/${crypto.randomUUID()}`,
		`/accounts/selected-account/workers/dispatch/namespaces/selected-namespace/scripts/${slate}/secrets`,
	])
		expect((await request(path)).status).toBe(404)
	for (const method of ["POST", "PUT", "PATCH", "DELETE"])
		expect(
			(
				await request(
					"/accounts/selected-account/workflows/selected-workflow/instances",
					method,
				)
			).status,
		).toBe(405)
})

describe("inspection content policy", () => {
	it("removes known privileged credentials wherever they occur", () => {
		const output = JSON.stringify({
			message: "token-a token-b token-a",
			nested: ["token-b"],
		})
		expect(JSON.parse(redactSecrets(output, ["token-a", "token-b", ""]))).toEqual({
			message: "[REDACTED] [REDACTED] [REDACTED]",
			nested: ["[REDACTED]"],
		})
	})

	it("preserves ordinary text", () => {
		expect(redactSecrets("Build succeeded", ["secret"])).toBe("Build succeeded")
	})

	it("hides private preparation results without changing public step fields", () => {
		const record = {
			name: "prepare slate-1",
			output: { members: ["private-person"] },
			status: "complete",
		}
		expect(redactPreparationOutput(record)).toEqual({
			name: record.name,
			output: "[REDACTED]",
			status: "complete",
		})
		expect(record.output).toEqual({ members: ["private-person"] })
	})

	it("retains other output structures", () => {
		const value = {
			extra: true,
			steps: [{ name: "build-1", output: { exitCode: 0, stdout: "Built app" } }],
		}
		expect(redactPreparationOutput(value)).toEqual(value)
	})
})
