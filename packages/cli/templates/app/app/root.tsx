import { connectionRequiredSchema, secretRequiredSchema } from "@usecontextlayer/sdk"
import { isRouteErrorResponse, Outlet } from "react-router"
import type { Route } from "./+types/root"
import "@/app/app.css"

export { Layout } from "@usecontextlayer/sdk/react"

export default function App() {
	return <Outlet />
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
	if (isRouteErrorResponse(error) && error.status === 409) {
		const missingSecret = secretRequiredSchema.safeParse(error.data)
		if (missingSecret.success)
			return (
				<main className="container mx-auto p-4 pt-16">
					<h1 className="text-2xl font-semibold">Set a secret to continue</h1>
					<p className="mt-3">
						Your personal secret <code>{missingSecret.data.name}</code> is required by
						this slate.
					</p>
					{import.meta.env.DEV ? (
						<p className="mt-3">
							Set <code>{missingSecret.data.name}</code> in your local environment, then
							restart <code>pnpm dev</code>.
						</p>
					) : (
						<p className="mt-3">
							Open the setup menu in the ContextLayer header above and save your secret,
							then refresh this page.
						</p>
					)}
				</main>
			)
		const unassignedConnection = connectionRequiredSchema.safeParse(error.data)
		if (unassignedConnection.success) {
			return (
				<main className="container mx-auto p-4 pt-16">
					<h1 className="text-2xl font-semibold">Assign an account to continue</h1>
					{import.meta.env.DEV ? (
						<>
							<p className="mt-3">
								From the checkout root, assign a connected account, then restart{" "}
								<code>pnpm dev</code>:
							</p>
							<pre className="mt-4 overflow-x-auto">
								<code>{`npx @usecontextlayer/cli connections local assign ${unassignedConnection.data.slug}`}</code>
							</pre>
						</>
					) : (
						<p className="mt-3">
							Open the setup menu in the ContextLayer header above and assign a connected
							account, then refresh this page.
						</p>
					)}
				</main>
			)
		}
	}

	let message = "Oops!"
	let details = "An unexpected error occurred."
	let stack: string | undefined

	if (isRouteErrorResponse(error)) {
		message = error.status === 404 ? "404" : "Error"
		details =
			error.status === 404
				? "The requested page could not be found."
				: error.statusText || details
	} else if (import.meta.env.DEV && error instanceof Error) {
		details = error.message
		stack = error.stack
	}

	return (
		<main className="container mx-auto p-4 pt-16">
			<h1>{message}</h1>
			<p>{details}</p>
			{stack && (
				<pre className="w-full overflow-x-auto p-4">
					<code>{stack}</code>
				</pre>
			)}
		</main>
	)
}
