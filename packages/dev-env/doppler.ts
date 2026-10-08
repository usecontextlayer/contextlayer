import { execa } from "execa"
import { z } from "zod"

export async function readDopplerEnv(cwd: string, project: string, config: string) {
	const { stdout } = await execa(
		"doppler",
		[
			"secrets",
			"download",
			"--no-file",
			"--format=json",
			"--project",
			project,
			"--config",
			config,
		],
		{ cwd },
	)
	return z.record(z.string(), z.string()).parse(JSON.parse(stdout))
}
