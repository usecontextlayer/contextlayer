import type { AppConnection } from "@usecontextlayer/shared/app-connections"

export type { AppConnection } from "@usecontextlayer/shared/app-connections"

export interface Connections {
	list(): Promise<AppConnection[]>
}
