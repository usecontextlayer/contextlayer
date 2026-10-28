import assert from "node:assert/strict"
import { isDeepStrictEqual } from "node:util"
import type { models, PolarCore } from "@polar-sh/sdk/2026-10"
import {
	createBenefits,
	getBenefits,
	iterListBenefits,
	updateBenefits,
} from "@polar-sh/sdk/2026-10/services/benefits"
import {
	createMeters,
	getMeters,
	iterListMeters,
	updateMeters,
} from "@polar-sh/sdk/2026-10/services/meters"
import {
	createProducts,
	getProducts,
	iterListProducts,
	updateBenefitsProducts,
	updateProducts,
} from "@polar-sh/sdk/2026-10/services/products"

const metadata = (role: string) => ({ contextlayer_seed: role })

function unique<T>(items: T[], role: string) {
	assert(
		items.length <= 1,
		`Ambiguous seed role ${role}; resolve duplicate resources before rerunning.`,
	)
	return items[0]
}

function adoptable(resource: { metadata: models.MetadataOutputType }, role: string) {
	assert(
		!resource.metadata.contextlayer_seed || resource.metadata.contextlayer_seed === role,
		`Resource already belongs to another seed role; expected ${role}.`,
	)
}

export async function seedCatalog(
	polar: PolarCore,
	prerequisites: Record<string, string>,
) {
	const products = await Array.fromAsync(iterListProducts(polar)())
	const definitions = [
		{ amount: 0, key: "POLAR_FREE_PRODUCT_ID", name: "Free", role: "free", units: 5_000 },
		{
			amount: 4_000,
			key: "POLAR_PRO_PRODUCT_ID",
			name: "Pro",
			role: "pro",
			unitAmount: "0.200000000000",
			units: 20_000,
		},
		{
			amount: 20_000,
			key: "POLAR_ULTRA_PRODUCT_ID",
			name: "Ultra",
			role: "ultra",
			unitAmount: "0.160000000000",
			units: 125_000,
		},
		{
			amount: 0,
			key: "POLAR_DEVENV_UNLIMITED_PRODUCT_ID",
			name: "DevEnv Unlimited",
			role: "devenv-unlimited",
			units: 0,
		},
	] as const
	const existing = new Map<string, models.Product>()
	for (const definition of definitions) {
		const tagged = unique(
			products.filter(
				(product) => product.metadata.contextlayer_seed === definition.role,
			),
			definition.role,
		)
		const id = prerequisites[definition.key]
		const selected = id ? await getProducts(polar)(id) : tagged
		assert(
			!tagged || !selected || tagged.id === selected.id,
			`${definition.key} conflicts with the tagged ${definition.role} product.`,
		)
		if (selected) {
			adoptable(selected, definition.role)
			existing.set(definition.role, selected)
		} else if (definition.role !== "devenv-unlimited") {
			const unmarked = products.filter(
				(product) =>
					!product.is_archived &&
					product.is_recurring &&
					product.visibility === "public" &&
					!product.metadata.contextlayer_seed,
			)
			assert(
				!unmarked.length,
				`Set ${definition.key} in platform/dev to explicitly adopt the existing ${definition.name} product. Unmarked public recurring products: ${unmarked.map((product) => product.id).join(", ")}.`,
			)
		}
	}

	const meterDefinition = {
		aggregation: { func: "sum", property: "clips" },
		custom_label: "clip",
		custom_multiplier: 1_000,
		filter: {
			clauses: ["loader_call", "action_call", "tool_call"].map((value) => ({
				operator: "eq" as const,
				property: "name",
				value,
			})),
			conjunction: "or",
		},
		metadata: metadata("clips"),
		name: "Clips",
		unit: "custom",
	} satisfies models.MeterCreate
	const taggedMeter = unique(
		await Array.fromAsync(iterListMeters(polar)({ metadata: metadata("clips") })),
		"clips",
	)
	const configuredMeter = prerequisites.POLAR_CLIPS_METER_ID
		? await getMeters(polar)(prerequisites.POLAR_CLIPS_METER_ID)
		: undefined
	assert(
		!taggedMeter || !configuredMeter || taggedMeter.id === configuredMeter.id,
		"POLAR_CLIPS_METER_ID conflicts with the tagged Clips meter.",
	)
	const meter =
		configuredMeter ?? taggedMeter ?? (await createMeters(polar)(meterDefinition))
	adoptable(meter, "clips")
	assert(
		!meter.archived_at &&
			meter.unit === "custom" &&
			meter.custom_label === "clip" &&
			meter.custom_multiplier === 1_000 &&
			isDeepStrictEqual(meter.filter, meterDefinition.filter) &&
			isDeepStrictEqual(meter.aggregation, meterDefinition.aggregation),
		`Incompatible Clips meter ${meter.id}; resolve its configuration before rerunning.`,
	)
	if (meter.metadata.contextlayer_seed !== "clips")
		await updateMeters(polar)(meter.id, {
			metadata: { ...meter.metadata, ...metadata("clips") },
		})
	console.log(
		`Clips meter: ${meter.id} (${configuredMeter || taggedMeter ? "reused" : "created"})`,
	)

	const resolved = new Map<string, models.Product>()
	for (const definition of definitions) {
		const prior = existing.get(definition.role)
		const prices: models.ProductCreateRecurring["prices"] = [
			{ amount_type: "fixed", price_amount: definition.amount, price_currency: "usd" },
		]
		if ("unitAmount" in definition)
			prices.push({
				amount_type: "metered_unit",
				meter_id: meter.id,
				price_currency: "usd",
				unit_amount: definition.unitAmount,
			})
		let product =
			prior ??
			(await createProducts(polar)({
				metadata: metadata(definition.role),
				name: definition.name,
				prices,
				recurring_interval: "month",
				recurring_interval_count: 1,
				visibility: definition.role === "devenv-unlimited" ? "private" : "public",
			}))
		const activePrices = product.prices.filter((price) => !price.is_archived)
		assert(
			!product.is_archived &&
				product.name === definition.name &&
				product.recurring_interval === "month" &&
				product.recurring_interval_count === 1 &&
				product.visibility ===
					(definition.role === "devenv-unlimited" ? "private" : "public"),
			`Incompatible ${definition.role} product ${product.id}.`,
		)
		assert(
			activePrices.length === prices.length &&
				activePrices.every((price) => price.price_currency === "usd") &&
				activePrices.some(
					(price) =>
						price.amount_type === "fixed" && price.price_amount === definition.amount,
				),
			`Incompatible prices on ${definition.role} product ${product.id}.`,
		)
		if ("unitAmount" in definition)
			assert(
				activePrices.some(
					(price) =>
						price.amount_type === "metered_unit" &&
						price.meter_id === meter.id &&
						Number(price.unit_amount) === Number(definition.unitAmount) &&
						price.cap_amount === null,
				),
				`Incompatible metered price on ${definition.role} product ${product.id}.`,
			)
		if (product.metadata.contextlayer_seed !== definition.role)
			product = await updateProducts(polar)(product.id, {
				metadata: { ...product.metadata, ...metadata(definition.role) },
			})

		if (definition.units) {
			const role = `clips-${definition.role}`
			const tagged = unique(
				await Array.fromAsync(iterListBenefits(polar)({ metadata: metadata(role) })),
				role,
			)
			const attached = unique(
				product.benefits.filter(
					(benefit) =>
						benefit.type === "meter_credit" && benefit.properties.meter_id === meter.id,
				),
				role,
			)
			assert(
				!tagged || !attached || tagged.id === attached.id,
				`Conflicting ${role} benefits.`,
			)
			const benefit =
				tagged ??
				(attached
					? await getBenefits(polar)(attached.id)
					: await createBenefits(polar)({
							description: `${definition.units.toLocaleString("en-US")} clips a month`,
							metadata: metadata(role),
							properties: {
								meter_id: meter.id,
								rollover: false,
								units: definition.units,
							},
							type: "meter_credit",
						}))
			adoptable(benefit, role)
			assert(
				!benefit.is_deleted &&
					benefit.type === "meter_credit" &&
					benefit.properties.meter_id === meter.id &&
					benefit.properties.units === definition.units &&
					benefit.properties.rollover === false,
				`Incompatible benefit ${role} (${benefit.id}).`,
			)
			if (benefit.metadata.contextlayer_seed !== role)
				await updateBenefits(polar)(benefit.id, {
					metadata: { ...benefit.metadata, ...metadata(role) },
					type: "meter_credit",
				})
			assert(
				product.benefits.every((item) => item.id === benefit.id),
				`Unexpected benefits on ${definition.role} product ${product.id}; operator disposition is required.`,
			)
			if (!product.benefits.some((item) => item.id === benefit.id))
				product = await updateBenefitsProducts(polar)(product.id, {
					benefits: [benefit.id],
				})
			console.log(
				`${role} benefit: ${benefit.id} (${tagged || attached ? "reused" : "created"})`,
			)
		} else
			assert(
				product.benefits.length === 0,
				`Unlimited product ${product.id} must have no limited benefits.`,
			)
		resolved.set(definition.role, product)
		console.log(`${definition.name}: ${product.id} (${prior ? "reused" : "created"})`)
	}
	const intendedIds = new Set([...resolved.values()].map((product) => product.id))
	for (const product of products.filter(
		(product) =>
			!product.is_archived &&
			product.is_recurring &&
			product.visibility === "public" &&
			!intendedIds.has(product.id),
	))
		console.warn(
			`Unrelated public recurring product requires operator disposition: ${product.id} (${product.name})`,
		)
	const free = resolved.get("free")
	const unlimited = resolved.get("devenv-unlimited")
	assert(free && unlimited)
	return { free, meter, unlimited }
}
