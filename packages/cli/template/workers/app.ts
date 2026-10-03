import { createApp } from "@contextlayer/sdk/worker"

export default createApp({
	build: () => import("virtual:react-router/server-build"),
	development: import.meta.env.DEV,
	mode: import.meta.env.MODE,
})
