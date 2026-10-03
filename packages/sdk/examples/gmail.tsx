import { toolsContext } from "@contextlayer/sdk"
import { type LoaderFunctionArgs, useLoaderData } from "react-router"
import { z } from "zod"

const inbox = z.object({
	messages: z.array(
		z.object({
			messageId: z.string(),
			messageTimestamp: z.string(),
			sender: z.string(),
			subject: z.string(),
		}),
	),
})

export async function loader({ context }: LoaderFunctionArgs) {
	const result = await context
		.get(toolsContext)
		.call("work-email", "GMAIL_FETCH_EMAILS", {
			include_payload: false,
			label_ids: ["INBOX"],
			max_results: 5,
			verbose: false,
		})
	return { logId: result.logId, messages: inbox.parse(result.data).messages }
}

export default function Home() {
	const loaderData = useLoaderData<typeof loader>()
	return (
		<main className="mx-auto max-w-3xl p-8">
			<h1 className="text-2xl font-semibold">Your Gmail inbox</h1>
			<p className="mt-2 text-sm text-gray-500">
				Fetched by this page's server loader through your assigned Gmail connection.
			</p>
			<ul className="mt-6 divide-y divide-gray-200">
				{loaderData.messages.map((message) => (
					<li
						key={message.messageId}
						className="py-4"
					>
						<h2 className="font-medium">{message.subject}</h2>
						<p className="mt-1 text-sm text-gray-500">{message.sender}</p>
						<time
							className="text-xs text-gray-500"
							dateTime={message.messageTimestamp}
						>
							{message.messageTimestamp}
						</time>
					</li>
				))}
			</ul>
		</main>
	)
}
