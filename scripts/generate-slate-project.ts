import { rm } from "node:fs/promises"
import { resolve } from "node:path"
import { createSlateProject } from "@usecontextlayer/dev-env/slate"

const root = resolve(import.meta.dirname, "..")
const checkout = resolve(root, "artifacts/slate-project")
await rm(checkout, { force: true, recursive: true })
await createSlateProject(root, checkout)
