// This example's public/slate.json declares the connection; follow the SDK README to copy the app files and assign a connected Gmail account.
import { connectionRequiredSchema, toolsContext } from "@usecontextlayer/sdk"
import { Suspense } from "react"
import { Await, type LoaderFunctionArgs, useLoaderData } from "react-router"
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

export function loader({ context }: LoaderFunctionArgs) {
	const result = context
		.get(toolsContext)
		.call("work-email", "GMAIL_FETCH_EMAILS", {
			include_payload: false,
			label_ids: ["INBOX"],
			max_results: 5,
			verbose: false,
		})
		.then((result) => ({ messages: inbox.parse(result.data).messages }))
		.catch(async (error: unknown) => {
			if (error instanceof Response && error.status === 409) {
				const setup = connectionRequiredSchema.parse(await error.json())
				return { connectionRequired: setup.slug }
			}
			throw error
		})
	return { result }
}

export default function Home() {
	const loaderData = useLoaderData<typeof loader>()
	return (
		<main className="mx-auto max-w-3xl p-8">
			<h1 className="text-2xl font-semibold">Your Gmail inbox</h1>
			<p className="mt-2 text-sm text-gray-500">
				Fetched by this page's server loader through your connected Gmail account.
			</p>
			<Suspense
				fallback={
					<p
						className="mt-6"
						role="status"
					>
						Loading your inbox…
					</p>
				}
			>
				<Await resolve={loaderData.result}>
					{(result) =>
						"connectionRequired" in result ? (
							<section className="mt-6">
								<h2 className="font-semibold">Assign an account to continue</h2>
								{import.meta.env.DEV ? (
									<>
										<p className="mt-2">
											From the checkout root, assign a connected Gmail account, then
											restart <code>pnpm dev</code>:
										</p>
										<pre className="mt-4 overflow-x-auto">
											<code>{`npx @usecontextlayer/cli connections local assign ${result.connectionRequired}`}</code>
										</pre>
									</>
								) : (
									<p className="mt-2">
										Open the setup menu in the ContextLayer header above, assign a
										connected Gmail account, then refresh this page.
									</p>
								)}
							</section>
						) : (
							<ul className="mt-6 divide-y divide-gray-200">
								{result.messages.map((message) => (
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
						)
					}
				</Await>
			</Suspense>
		</main>
	)
}
