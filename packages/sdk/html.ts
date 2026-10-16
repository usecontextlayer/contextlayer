import { html } from "hono/html"

/** A complete HTML page with Bootstrap and a centered, responsive content card. */
export function htmlPage({
	children,
	title,
}: {
	children: ReturnType<typeof html>
	title: string
}) {
	return html`<!doctype html>
		<html lang="en" data-bs-theme="light">
			<head>
				<meta charset="utf-8">
				<meta name="viewport" content="width=device-width, initial-scale=1">
				<title>${title}</title>
				<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@6.0.0-alpha.1/dist/css/bootstrap.min.css" integrity="sha384-B/GM4XqrwHnWXNOWMbloTmrYXZg10cakYGmpfsR/bbzQ6JAJI4ihuyADKLnBgrCe" crossorigin="anonymous">
			</head>
			<body class="min-vh-100 d-flex flex-column bg-2">
				<main class="container my-auto py-5">
					<div class="row justify-content-center">
						<div class="col-12 sm:col-10 md:col-8 lg:col-6 xl:col-5 2xl:col-4">
							<div class="card border-0 shadow-sm rounded-7 bg-white">
								<div class="card-body p-6 sm:p-10">${children}</div>
							</div>
						</div>
					</div>
				</main>
			</body>
		</html>`
}
