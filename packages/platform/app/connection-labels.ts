import type { CredentialMode } from "@usecontextlayer/shared/declaration"

export const CONNECTION_MODE_LABELS = {
	owner: "shared connected account (all users of the slate use this one)",
	viewer: "your connected account (each user of the slate uses their own)",
} as const satisfies Record<CredentialMode, string>
