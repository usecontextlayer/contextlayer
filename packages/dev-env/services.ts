import { execa, type Subprocess } from "execa"
import waitOn from "wait-on"

type ServiceOptions = {
	cwd: string
	env: Record<string, string>
	url: URL
}

function startService(command: string[], { cwd, env, url }: ServiceOptions) {
	const subprocess: Subprocess<{ stdio: ["ignore", "inherit", "inherit"] }> = execa(
		"pnpm",
		command,
		{
			cwd,
			env,
			stdio: ["ignore", "inherit", "inherit"],
		},
	)
	const ready = Promise.race([
		waitOn({ resources: [`tcp:${url.hostname}:${url.port}`], timeout: 60_000 }),
		subprocess.then(() => {}),
	])
	return { process: subprocess, ready, url }
}

export function startNext(options: ServiceOptions) {
	return startService(
		["dev", "--hostname", options.url.hostname, "--port", options.url.port],
		options,
	)
}

export function startVite(options: ServiceOptions) {
	return startService(
		[
			"exec",
			"vite",
			"dev",
			"--host",
			options.url.hostname,
			"--port",
			options.url.port,
			"--strictPort",
		],
		options,
	)
}

export function startWrangler(options: ServiceOptions) {
	return startService(
		[
			"exec",
			"wrangler",
			"dev",
			"--env",
			"test",
			"--ip",
			options.url.hostname,
			"--port",
			options.url.port,
			"--inspector-port",
			"0",
		],
		options,
	)
}
