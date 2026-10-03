import { AuthProvider as BetterAuthProvider } from "@better-auth-ui/react"
import { QueryClient } from "@tanstack/react-query"
import { multiSessionClient, organizationClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"
import { type ReactNode, useState } from "react"

export function AuthProvider({
	issuer,
	children,
}: {
	issuer: string
	children: ReactNode
}) {
	const [authClient] = useState(() =>
		createAuthClient({
			baseURL: issuer,
			plugins: [multiSessionClient(), organizationClient()],
		}),
	)
	const [queryClient] = useState(() => new QueryClient())
	return (
		<BetterAuthProvider
			authClient={authClient}
			queryClient={queryClient}
			navigate={({ to, replace }) =>
				replace ? window.location.replace(to) : window.location.assign(to)
			}
		>
			{children}
		</BetterAuthProvider>
	)
}
