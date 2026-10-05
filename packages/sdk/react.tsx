import { chromeHeightSchema, chromePath } from "@usecontextlayer/shared/chrome"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { Links, Meta, Scripts, ScrollRestoration } from "react-router"
import { browserEnv } from "@/browser-env"

function Chrome() {
	const frame = useRef<HTMLIFrameElement>(null)
	const [src, setSrc] = useState<string>()
	const [height, setHeight] = useState(30)
	useEffect(() => {
		const target = browserEnv.CTX_APP_ID ?? window.location.hostname
		const url = new URL(
			`${chromePath}/apps/${encodeURIComponent(target)}`,
			browserEnv.CTX_PLATFORM_URL,
		)
		url.searchParams.set("parentOrigin", window.location.origin)
		if (browserEnv.CTX_APP_MANIFEST)
			url.searchParams.set("manifest", browserEnv.CTX_APP_MANIFEST)
		function resize(event: MessageEvent) {
			if (event.origin !== url.origin || event.source !== frame.current?.contentWindow)
				return
			const message = chromeHeightSchema.safeParse(event.data)
			if (message.success) setHeight(message.data.height)
		}
		window.addEventListener("message", resize)
		setSrc(url.href)
		return () => window.removeEventListener("message", resize)
	}, [])
	return (
		<iframe
			ref={frame}
			src={src}
			title="ContextLayer"
			style={{
				backgroundColor: "oklch(96.8% 0.007 247.896)",
				border: 0,
				borderBottom: "1px solid oklch(92.9% 0.013 255.508)",
				display: "block",
				height,
				width: "100%",
			}}
		/>
	)
}

export function Layout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<head>
				<meta charSet="utf-8" />
				<meta
					name="viewport"
					content="width=device-width, initial-scale=1"
				/>
				<Meta />
				<Links />
			</head>
			<body>
				<Chrome />
				{children}
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	)
}
