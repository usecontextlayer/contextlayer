import { Composio } from "@composio/core"
import type { z } from "zod"
import type { AppAccess } from "@/apps.server"
import type { PlatformDb } from "@/database"
import type { AppConnectionAssignmentUserId } from "@/database/models/public/AppConnectionAssignment"
import type { toolCallSchema } from "@/tools.schema"

export async function callTool(
	db: PlatformDb,
	apiKey: string,
	{ app, identity }: AppAccess,
	call: z.infer<typeof toolCallSchema>,
) {
	const assignment = await db
		.selectFrom("app_connection_assignment")
		.select("connection_id")
		.where("app_id", "=", app.id)
		.where("user_id", "=", identity.user.id as AppConnectionAssignmentUserId)
		.where("slug", "=", call.slug)
		.executeTakeFirst()
	if (!assignment) return null

	const composio = new Composio({ apiKey })
	const account = await composio.connectedAccounts.get(assignment.connection_id)
	const session = await composio.create(identity.user.id, {
		connectedAccounts: { [account.toolkit.slug]: [assignment.connection_id] },
		toolkits: [account.toolkit.slug],
	})
	return session.execute(call.tool, call.arguments)
}
