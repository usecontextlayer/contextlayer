import { index, type RouteConfig, route } from "@react-router/dev/routes"

export default [
	route("chrome/apps/:target", "routes/chrome.tsx"),
	route("chrome/sign-in", "routes/chrome-sign-in.tsx"),
	index("routes/index.ts"),
	route("personal/apps", "routes/apps.tsx", { id: "personal-apps" }),
	route("org/:organizationSlug/apps", "routes/apps.tsx", { id: "organization-apps" }),
] satisfies RouteConfig
