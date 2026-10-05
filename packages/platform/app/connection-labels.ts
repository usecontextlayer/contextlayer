import type { CredentialMode } from "@usecontextlayer/shared/slate"

export const CONNECTION_MODE_LABELS = {
	owner: "shared account (all users of the app use this one)",
	viewer: "your account (each user of the app uses their own)",
} as const satisfies Record<CredentialMode, string>
