import { createContext } from "react-router"
import type { ArtifactsClient } from "@/artifacts.server"
import type { PlatformDb } from "@/database"

export const databaseContext = createContext<PlatformDb>()
export const artifactsContext = createContext<ArtifactsClient>()
