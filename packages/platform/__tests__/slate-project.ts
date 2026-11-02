import { cp } from "node:fs/promises"
import { execa } from "execa"
import { inject } from "vitest"

declare module "vitest" {
	export interface ProvidedContext {
		slateProject: string
	}
}

export async function copySlateProject(
	checkout: string,
	{ installDependencies = false }: { installDependencies?: boolean } = {},
) {
	await cp(inject("slateProject"), checkout, { recursive: true })
	if (installDependencies) await execa("pnpm", ["install"], { cwd: checkout })
}
