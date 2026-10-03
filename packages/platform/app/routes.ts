import { index, type RouteConfig, route } from "@react-router/dev/routes"

export default [
	index("routes/index.ts"),
	route("personal/apps", "routes/apps.tsx", { id: "personal-apps" }),
	route("org/:organizationSlug/apps", "routes/apps.tsx", { id: "organization-apps" }),
] satisfies RouteConfig
