import { databasesContext, toolsContext } from "@usecontextlayer/sdk"
import type { LoaderFunctionArgs } from "react-router"

export async function loader({ context, request }: LoaderFunctionArgs) {
	const url = new URL(request.url)
	const slug = url.searchParams.get("slug") ?? "mail"
	try {
		return Response.json(
			url.searchParams.has("database")
				? await context
						.get(databasesContext)
						.query(slug, "SELECT id, body FROM updates ORDER BY created_at")
				: await context
						.get(toolsContext)
						.call(slug, "GMAIL_GET_PROFILE", { user_id: "me" }),
		)
	} catch (error) {
		if (error instanceof Response) throw error
		if (error instanceof Error)
			return Response.json({ error: error.message }, { status: 400 })
		throw error
	}
}
