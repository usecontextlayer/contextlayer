import { database, databasesContext } from "@usecontextlayer/sdk"
import { Form, useNavigation } from "react-router"
import { z } from "zod"
import type { DB } from "@/databases/notes/types"
import type { Route } from "./+types/home"

export function meta() {
	return [{ title: "Notes — Your ContextLayer slate" }]
}

export async function loader({ context }: Route.LoaderArgs) {
	const db = database<DB>(context.get(databasesContext), "notes")
	return {
		notes: await db.selectFrom("notes").selectAll().orderBy("id", "desc").execute(),
	}
}

export async function action({ context, request }: Route.ActionArgs) {
	const body = z
		.string()
		.trim()
		.min(1)
		.parse((await request.formData()).get("body"))
	const db = database<DB>(context.get(databasesContext), "notes")
	return db.insertInto("notes").values({ body }).returningAll().executeTakeFirstOrThrow()
}

export default function Home({ loaderData }: Route.ComponentProps) {
	const navigation = useNavigation()
	return (
		<main className="mx-auto max-w-2xl space-y-6 px-4 py-16">
			<h1 className="text-2xl font-semibold">Notes</h1>
			<p>A shared notebook for your slate. Add a note to try its database.</p>
			<Form
				method="post"
				className="flex gap-3"
			>
				<label
					htmlFor="body"
					className="sr-only"
				>
					Note
				</label>
				<input
					id="body"
					name="body"
					required
					placeholder="Write a note…"
					className="min-w-0 flex-1 rounded border px-3 py-2"
				/>
				<button
					type="submit"
					disabled={navigation.state !== "idle"}
					className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
				>
					Add note
				</button>
			</Form>
			{loaderData.notes.length ? (
				<ul className="divide-y">
					{loaderData.notes.map((note) => (
						<li
							key={note.id}
							className="py-3"
						>
							{note.body}
						</li>
					))}
				</ul>
			) : (
				<p>No notes yet.</p>
			)}
			<p className="text-sm">
				Edit <code>app/routes/home.tsx</code> to build your app. Your{" "}
				<code>README.md</code> explains migrations, query types, and deployment.
			</p>
		</main>
	)
}
