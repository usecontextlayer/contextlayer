import { Outlet } from "react-router"

export default function Root() {
	return (
		<html lang="en">
			<head />
			<body>
				<Outlet />
			</body>
		</html>
	)
}
