import type { models, PolarCore } from "@polar-sh/sdk/2026-10"
import { getMeters } from "@polar-sh/sdk/2026-10/services/meters"
import { getProducts } from "@polar-sh/sdk/2026-10/services/products"
import { execa, type Subprocess } from "execa"
import { z } from "zod"

const polarCli = execa({ localDir: import.meta.dirname, preferLocal: true })

export async function readPolarWebhookSecret(env: Record<string, string>) {
	const { stdout } = await polarCli("polar", ["listen", "--print-secret"], { env })
	return z.string().trim().min(1).parse(stdout)
}

export function startPolarListener(
	url: URL,
	env: Record<string, string>,
): Subprocess<{ stdio: ["ignore", "inherit", "inherit"] }> {
	return polarCli("polar", ["listen", url.href], {
		env,
		stdio: ["ignore", "inherit", "inherit"],
	})
}

export type PolarCatalog = {
	clipsBenefit: models.BenefitMeterCredit
	clipsMeter: models.Meter
	freeProduct: models.Product
}

export async function readPolarCatalog(
	client: PolarCore,
	freeProductId: string,
): Promise<PolarCatalog> {
	const freeProduct = await getProducts(client)(freeProductId)
	const clipsBenefit = freeProduct.benefits.find(
		(benefit) => benefit.type === "meter_credit",
	)
	if (!clipsBenefit) throw new Error("The Free product has no meter-credit benefit")
	const clipsMeter = await getMeters(client)(clipsBenefit.properties.meter_id)
	return { clipsBenefit, clipsMeter, freeProduct }
}
