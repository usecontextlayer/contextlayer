// The recorder writes to a customer production organisation. These constants and the
// allowlist below confine it to one approved board; changing the destination must be a
// reviewed code change, never runtime configuration.

export const ORG_URL = "https://org1c9f9fa0.crm3.dynamics.com"

/**
 * The scratch board, owned by the operator's own account in the customer tenant.
 *
 * `SCRATCH_PROJECT_NAME` is not decoration: `record.ts` reads the live row and refuses to
 * start unless the name matches, so a GUID mistyped into naming some OTHER real
 * project fails before the first write instead of halfway through a run.
 */
export const SCRATCH_PROJECT_ID = "c3a4fef9-4577-f111-ab0f-7c1e52407ab7"
export const SCRATCH_PROJECT_NAME = "ZZ ContextLayer API Probe (safe to delete)"

export const SCRATCH_BUCKET_ID = "1e995103-4677-f111-ab0f-7c1e52407ab7"
export const SCRATCH_LABEL_ID = "a72abcfc-177b-f111-8067-0022483d6420"
export const SCRATCH_PROJECT_TEAM_MEMBER_ID = "1a995103-4677-f111-ab0f-7c1e52407ab7"

// Keep every other board's id out of this repository. The allowlist protects unnamed
// boards by default; a blocklist would protect only the boards somebody anticipated.

/**
 * A request that would have named a record outside the approved board.
 *
 * Its own type lets the recorder's live guard proof distinguish the intended refusal
 * from a request or network failure.
 */
export class BoardGuardViolation extends Error {
	override readonly name = "BoardGuardViolation"
}

// Deliberately this file's OWN copy rather than the recorder's. The normalizer's regex
// serves a different purpose and may be tuned for it; the guard must not be weakened
// as a side effect of an edit to something that only rewrites text.
const GUID = /[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}/g

export type BoardGuard = {
	/** Register an id as one this run owns and may send. Returns it, for chaining. */
	registerOwnedId: (id: string) => string
	/** Refuse another organisation or a record this run does not own. */
	assertRequestWithinApprovedBoard: (method: string, url: string, body?: string) => void
}

/**
 * A fresh allowlist and the check over it. Separate instances cannot inherit records
 * owned by another run.
 */
export function createBoardGuard(): BoardGuard {
	const ownedIds = new Set<string>()

	return {
		assertRequestWithinApprovedBoard(method: string, url: string, body?: string): void {
			// Record ids have meaning only within their organisation, so validate the
			// destination before considering the ids it carries.
			if (URL.parse(url)?.origin !== ORG_URL) {
				throw new BoardGuardViolation(
					`REFUSED: ${method} ${url} — this script may only ever reach ${ORG_URL}. Nothing was sent.`,
				)
			}
			for (const guid of `${url} ${body ?? ""}`.match(GUID) ?? []) {
				if (!ownedIds.has(guid.toLowerCase())) {
					throw new BoardGuardViolation(
						`REFUSED, AND READ THIS TWICE: ${method} ${url} named ${guid}, which this run does not own. Nothing was sent. This organisation is the customer's PRODUCTION organisation and holds hundreds of real projects, several with near-duplicate names, told apart only by id — so an id nobody registered may well be somebody's live board. Register every id where this run creates it or receives it from this board's service response. Widening the allowlist to make this message go away is never the fix.`,
					)
				}
			}
		},
		registerOwnedId(id: string): string {
			ownedIds.add(id.toLowerCase())
			return id
		},
	}
}
