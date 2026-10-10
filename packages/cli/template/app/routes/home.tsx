export function meta() {
	return [{ title: "Your ContextLayer slate" }]
}

export default function Home() {
	return (
		<main className="mx-auto max-w-2xl space-y-6 px-4 py-16">
			<h1 className="text-2xl font-semibold">Your ContextLayer slate is ready</h1>
			<p>
				Edit <code>app/routes/home.tsx</code> to build your first page.
			</p>
			<p>
				To read from a connected service, declare a connection in{" "}
				<code>public/slate.json</code>, assign a connected account through the CLI, and
				call its tools from a route loader. Follow the Gmail example in the SDK guide to
				get started.
			</p>
			<p>
				Your checkout&apos;s <code>README.md</code> explains development, connections, and
				deployment. The SDK guide is in{" "}
				<code>node_modules/@usecontextlayer/sdk/README.md</code>.
			</p>
		</main>
	)
}
