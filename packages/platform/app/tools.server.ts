import { Composio } from "@composio/core"
import type { z } from "zod"
import type { PlatformDb } from "@/database"
import type { AppId } from "@/database/models/public/App"
import type { AppConnectionAssignmentUserId } from "@/database/models/public/AppConnectionAssignment"
import type { toolCallSchema } from "@/tools.schema"

export async function callTool(
	db: PlatformDb,
	apiKey: string,
	appId: AppId,
	userId: string,
	call: z.infer<typeof toolCallSchema>,
) {
	const assignment = await db
		.selectFrom("app_connection_assignment")
		.select("connection_id")
		.where("app_id", "=", appId)
		.where("user_id", "=", userId as AppConnectionAssignmentUserId)
		.where("slug", "=", call.slug)
		.executeTakeFirst()
	if (!assignment) return null

	const composio = new Composio({ apiKey })
	const account = await composio.connectedAccounts.get(assignment.connection_id)
	const session = await composio.create(userId, {
		connectedAccounts: { [account.toolkit.slug]: [assignment.connection_id] },
		toolkits: [account.toolkit.slug],
	})
	return session.execute(call.tool, call.arguments)
}
