import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router"

async function echo(request: Request) {
	return Response.json({
		authorization: request.headers.get("authorization"),
		body: await request.text(),
		cookie: request.headers.get("cookie"),
		method: request.method,
	})
}

export const loader = ({ request }: LoaderFunctionArgs) => echo(request)
export const action = ({ request }: ActionFunctionArgs) => echo(request)
