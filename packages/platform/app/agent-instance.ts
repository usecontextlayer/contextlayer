import { hasViewerResources, type Resources } from "@usecontextlayer/shared/declaration"

export { getAgentInstanceName } from "@usecontextlayer/shared/agent-routing"

export function getAgentUnattendedScope(resources: Resources) {
	return hasViewerResources(resources) ? "member" : "app"
}
