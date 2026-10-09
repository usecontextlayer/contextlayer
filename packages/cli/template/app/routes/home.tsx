export function meta() {
	return [{ title: "Your ContextLayer app" }]
}

export default function Home() {
	return (
		<main className="mx-auto max-w-2xl space-y-6 px-4 py-16">
			<h1 className="text-2xl font-semibold">Your ContextLayer app is ready</h1>
			<p>
				Edit <code>app/routes/home.tsx</code> to build your first page.
			</p>
			<p>
				To read from a connected service, declare it in <code>public/slate.json</code>,
				assign your account through the CLI, and call its tools from a route loader.
				Follow the Gmail example in the SDK guide to get started.
			</p>
			<p>
				Your project&apos;s <code>README.md</code> explains development, connections, and
				publishing. The SDK guide is in{" "}
				<code>node_modules/@usecontextlayer/sdk/README.md</code>.
			</p>
		</main>
	)
}
