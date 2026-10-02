import { index, type RouteConfig, route } from "@react-router/dev/routes"

export default [
	index("routes/index.ts"),
	route("apps", "routes/apps.tsx"),
] satisfies RouteConfig
