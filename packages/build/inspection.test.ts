import { INSPECTION_SLATE_ID_HEADER } from "@usecontextlayer/shared/inspection"
import { expect, it } from "vitest"
import { inspectCloudflare } from "@/inspection"

it("exposes configuration without credentials and rejects unselected upstream authority", async () => {
	const slateId = crypto.randomUUID()
	const env = {
		CF_TOKEN: "private-cloudflare-credential",
		CLOUDFLARE_ACCOUNT_ID: "selected-account",
		CTX_CI_WORKFLOW: "selected-workflow",
		CTX_DISPATCH_NAMESPACE: "selected-namespace",
	}
	const request = (path: string, method = "GET") =>
		inspectCloudflare(
			env,
			new Request(`https://inspection${path}`, {
				headers: { [INSPECTION_SLATE_ID_HEADER]: slateId },
				method,
			}),
		)
	expect(await (await request("/")).json()).toEqual({
		account_id: env.CLOUDFLARE_ACCOUNT_ID,
		dispatch_namespace: env.CTX_DISPATCH_NAMESPACE,
		script_name: slateId,
		workflow_name: env.CTX_CI_WORKFLOW,
	})
	for (const path of [
		"/accounts/another-account/workflows/selected-workflow/instances",
		"/accounts/selected-account/workflows/another-workflow/instances",
		"/accounts/selected-account/workflows/selected-workflow/instances/run-id",
		"/accounts/selected-account/workflows/selected-workflow/instances/run-id/step?name=build",
		`/accounts/selected-account/workers/dispatch/namespaces/selected-namespace/scripts/${crypto.randomUUID()}`,
		`/accounts/selected-account/workers/dispatch/namespaces/selected-namespace/scripts/${slateId}/secrets`,
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
