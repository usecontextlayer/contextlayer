import { MeridianProfiles as SharedMeridianProfiles } from "@usecontextlayer/shared/meridian"
import type { PlatformBindings } from "@/env"
import { loadMeridianProfiles } from "@/secrets.server"

export { Meridian } from "@usecontextlayer/shared/meridian"

export class MeridianProfiles extends SharedMeridianProfiles<PlatformBindings> {
	load() {
		return loadMeridianProfiles(this.env)
	}
}
