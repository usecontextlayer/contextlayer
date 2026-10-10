import { index, layout, type RouteConfig, route } from "@react-router/dev/routes"

export default [
	route("chrome/slates/:target", "routes/chrome.tsx"),
	index("routes/index.ts"),
	layout("routes/dashboard.tsx", [
		route("slates/:slateId", "routes/slate.tsx", [
			index("routes/slate-overview.tsx"),
			route("views", "routes/slate-views.tsx"),
			route("agents", "routes/slate-agents.tsx"),
			route("resources", "routes/slate-resources.tsx"),
			route("deployments", "routes/slate-deployments.tsx"),
			route("settings", "routes/slate-settings.tsx"),
		]),
		route("personal/slates", "routes/slates.tsx", { id: "personal-slates" }),
		route("org/:organizationSlug/slates", "routes/slates.tsx", {
			id: "organization-slates",
		}),
	]),
] satisfies RouteConfig
