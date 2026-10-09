import { reactRouter } from "@react-router/dev/vite"
import { contextlayer } from "@usecontextlayer/sdk/vite"
import { defineConfig } from "vite"

export default defineConfig((env) => ({ plugins: [contextlayer(env), reactRouter()] }))
