import type { Config } from "@react-router/dev/config"

export default {
	basename: "/dashboard",
	buildDirectory: import.meta.env.MODE === "test" ? "build-test" : "build",
	ssr: true,
} satisfies Config
