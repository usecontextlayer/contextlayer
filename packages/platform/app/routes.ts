import { index, layout, type RouteConfig, route } from "@react-router/dev/routes"

export default [
	route("chrome/apps/:target", "routes/chrome.tsx"),
	index("routes/index.ts"),
	layout("routes/dashboard.tsx", [
		route("apps/:appId", "routes/app.tsx", [
			index("routes/app-overview.tsx"),
			route("views", "routes/app-views.tsx"),
			route("agents", "routes/app-agents.tsx"),
			route("resources", "routes/app-resources.tsx"),
			route("deployments", "routes/app-deployments.tsx"),
			route("settings", "routes/app-settings.tsx"),
		]),
		route("personal/apps", "routes/apps.tsx", { id: "personal-apps" }),
		route("org/:organizationSlug/apps", "routes/apps.tsx", { id: "organization-apps" }),
	]),
] satisfies RouteConfig
