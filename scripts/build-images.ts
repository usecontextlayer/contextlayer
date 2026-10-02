import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Projects the container-image graph (the images/<name>/Dockerfiles) into a
// `docker buildx bake` definition for local builds and CI callers. Image sources
// are currently absent; the builder is retained. Each
// images/<name>/Dockerfile is a bake target; a derived image
// (`FROM ghcr.io/usecontextlayer/<base>:${CTX_VERSION}`)
// declares a `contexts` override mapping that FROM ref to `target:<base>`, so bake
// builds the base first and the derived consumes it from the local build store — no
// registry round-trip mid-build, any DAG depth, no hand-rolled topological ordering.
//
// Multi-arch callers run one bake per arch on a native runner (no QEMU), pushing
// every image by digest; `emit-digests` splits bake's --metadata-file into one
// digest file per image, and `manifest` joins an image's per-arch digests into a
// :version + :latest manifest list.
//
// Functional core (parseInRepoBases, buildBakeDefinition) is pure; the imperative
// shell (discoverImages, run*) does the I/O.
//
// Subcommands:
//   list                              - print the image names (JSON) so CI can fan
//                                       out the manifest matrix (validates pinning)
//   bake <version> <arch>             - print the bake definition (JSON) for one
//                                       arch (CI build leg, with per-image cache)
//   execute <version>                 - build the whole graph locally for the host
//                                       arch and load it (dev)
//   emit-digests <meta> <dir> <arch>  - split bake's --metadata-file into one
//                                       "<image>.<arch>" digest file per image
//   manifest <image> <ver> <dir>      - join an image's per-arch digests into a
//                                       :version + :latest manifest list

const IMAGES_DIR = "images"
const IMAGE_REGISTRY_PREFIX = "ghcr.io/usecontextlayer/"
// Supported native build architectures and the digest suffixes `manifest` joins.
const ARCHES = ["amd64", "arm64"] as const
// A `FROM` directive on any line (multi-stage included), case-insensitive, with
// optional flags like `--platform=...` before the ref. Comment lines (leading
// `#`) never match the line-start anchor; an incidental "FROM" inside a RUN
// string isn't at line start either. Captures the full image ref.
const FROM_REF_RE = /^\s*FROM\s+(?:--\S+\s+)*(\S+)/i
const VERSION_RE = /^\d+\.\d+\.\d+$/
const ARCH_RE = /^(?:amd64|arm64)$/
// Every in-repo base must pin its tag to this build arg, so the release version
// flows through the whole graph — no hardcoded or floating base tags.
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal Docker build-arg placeholder, not a JS template
const CTX_VERSION_PLACEHOLDER = "${CTX_VERSION}"

function log(message: string): void {
	console.error(`[build-images] ${message}`)
}

// --- Functional core (pure) ------------------------------------------------

// An in-repo image referenced by a `FROM`, with the tag it declared (undefined
// when the FROM gave no tag).
type InRepoBase = { name: string; tag: string | undefined }

type ImageNode = {
	name: string
	baseImages: string[]
}

// Every in-repo image referenced by a `FROM ghcr.io/usecontextlayer/<name>:<tag>`
// directive, paired with its declared tag, restricted to `knownImages`. External
// bases (node:24-trixie, scratch) and named build stages are skipped.
function parseInRepoBases(
	dockerfile: string,
	knownImages: ReadonlySet<string>,
): InRepoBase[] {
	const bases: InRepoBase[] = []
	for (const line of dockerfile.split("\n")) {
		const ref = line.match(FROM_REF_RE)?.[1]
		if (ref === undefined || !ref.startsWith(IMAGE_REGISTRY_PREFIX)) {
			continue
		}
		const [name, tag] = ref.slice(IMAGE_REGISTRY_PREFIX.length).split(":")
		if (name !== undefined && knownImages.has(name)) {
			bases.push({ name, tag })
		}
	}
	return bases
}

// The canonical registry ref for an in-repo image at a version. Used both as a
// bake target's tag and as the `contexts` override key — the latter must equal
// the ref a derived image's `FROM …:${CTX_VERSION}` resolves to (with CTX_VERSION
// set from the target's args), so bake redirects it to the local base target.
function imageRef(name: string, version: string): string {
	return `${IMAGE_REGISTRY_PREFIX}${name}:${version}`
}

function baseContexts(baseImages: string[], version: string): Record<string, string> {
	return Object.fromEntries(
		baseImages.map((base) => [imageRef(base, version), `target:${base}`]),
	)
}

type BakeDefinition = {
	group: { default: { targets: string[] } }
	target: Record<string, Record<string, unknown>>
}

// `arch` identifies a CI build leg, pinning the platform and per-image registry
// build cache. Omit it to leave those settings to the caller. The caller always
// chooses the output (push-by-digest, --load or cache-only).
function buildBakeDefinition(
	nodes: ImageNode[],
	version: string,
	arch: string | undefined,
): BakeDefinition {
	const target: BakeDefinition["target"] = {}
	for (const node of nodes) {
		const def: Record<string, unknown> = {
			args: { CTX_VERSION: version },
			context: ".",
			dockerfile: path.join(IMAGES_DIR, node.name, "Dockerfile"),
			// The CI arch leg pushes by digest (`push-by-digest=true`), and buildkit
			// rejects a TAGGED ref on a digest push ("can't push tagged ref :<v> by
			// digest"). So name the target by BARE repo there; its :version + :latest
			// tags are applied afterward by the manifest join (runManifest). Local
			// `execute` (no arch, --load) keeps the version tag so the built image is
			// directly runnable. The `contexts` keys below stay version-tagged — they
			// must equal what a derived image's `FROM …:${CTX_VERSION}` resolves to.
			tags: [
				arch === undefined
					? imageRef(node.name, version)
					: `${IMAGE_REGISTRY_PREFIX}${node.name}`,
			],
		}
		if (node.baseImages.length > 0) {
			def.contexts = baseContexts(node.baseImages, version)
		}
		if (arch !== undefined) {
			const cache = `${IMAGE_REGISTRY_PREFIX}${node.name}:buildcache-${arch}`
			def.platforms = [`linux/${arch}`]
			def["cache-from"] = [`type=registry,ref=${cache}`]
			def["cache-to"] = [`type=registry,ref=${cache},mode=max`]
		}
		target[node.name] = def
	}
	return {
		group: { default: { targets: nodes.map((node) => node.name) } },
		target,
	}
}

// --- Imperative shell ------------------------------------------------------

function discoverImages(): ImageNode[] {
	const names = fs
		.readdirSync(IMAGES_DIR)
		.filter((name) => fs.existsSync(path.join(IMAGES_DIR, name, "Dockerfile")))
		.sort()
	const known = new Set(names)
	const nodes = names.map((name) => {
		const dockerfile = fs.readFileSync(path.join(IMAGES_DIR, name, "Dockerfile"), "utf8")
		const bases = parseInRepoBases(dockerfile, known)
		for (const base of bases) {
			if (base.tag !== CTX_VERSION_PLACEHOLDER) {
				throw new Error(
					`images/${name}/Dockerfile: in-repo base ${IMAGE_REGISTRY_PREFIX}${base.name} ` +
						`must be pinned to :\${CTX_VERSION} (found ${base.tag === undefined ? "no tag" : `:${base.tag}`}); ` +
						"otherwise the release version never reaches the build.",
				)
			}
		}
		const baseImages = [...new Set(bases.map((base) => base.name))].sort()
		return { baseImages, name }
	})
	log(`discovered ${nodes.length} image(s): ${names.join(", ")}`)
	for (const node of nodes) {
		if (node.baseImages.length > 0) {
			log(`  ${node.name} ← ${node.baseImages.join(", ")}`)
		}
	}
	return nodes
}

// Run a command with inherited stdio, rejecting on non-zero exit.
function spawnInherit(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: "inherit",
		})
		child.on("error", reject)
		child.on("exit", (code) => {
			if (code === 0) {
				resolve()
			} else {
				reject(new Error(`${command} ${args.join(" ")} exited with ${code}`))
			}
		})
	})
}

function runList(): void {
	const names = discoverImages().map((node) => node.name)
	// stdout carries only the machine-readable list (CI consumes this).
	console.log(JSON.stringify(names))
}

function runBake(version: string, arch: string): void {
	const definition = buildBakeDefinition(discoverImages(), version, arch)
	// stdout carries only the bake definition (CI writes it to docker-bake.json).
	console.log(JSON.stringify(definition, null, 2))
}

async function runExecute(version: string): Promise<void> {
	const definition = buildBakeDefinition(discoverImages(), version, undefined)
	const file = path.join(os.tmpdir(), `ctx-bake-${version}.json`)
	fs.writeFileSync(file, JSON.stringify(definition, null, 2))
	log(`wrote bake definition → ${file}; building locally (--load) …`)
	await spawnInherit("docker", ["buildx", "bake", "-f", file, "--load"])
	log(`built ${discoverImages().length} image(s) at ${version}`)
}

// Split bake's --metadata-file (target → { "containerimage.digest": "sha256:…" })
// into one "<image>.<arch>" file per image holding its digest, for the manifest
// phase to join across arches. Fails loud if any discovered image is missing.
function runEmitDigests(metadataFile: string, dir: string, arch: string): void {
	const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8")) as Record<
		string,
		{ "containerimage.digest"?: string }
	>
	fs.mkdirSync(dir, { recursive: true })
	const images = discoverImages().map((node) => node.name)
	for (const image of images) {
		const digest = metadata[image]?.["containerimage.digest"]
		if (digest === undefined) {
			throw new Error(`bake metadata ${metadataFile} has no digest for image "${image}"`)
		}
		fs.writeFileSync(path.join(dir, `${image}.${arch}`), digest)
	}
	log(`wrote ${images.length} digest(s) for ${arch} → ${dir}`)
}

// Join one image's per-arch push-by-digest builds (the "<image>.<arch>" files
// emit-digests wrote, each holding a sha256 digest) into a multi-arch manifest
// list tagged :version + :latest.
function runManifest(image: string, version: string, digestsDir: string): Promise<void> {
	const refs = ARCHES.map((arch) => path.join(digestsDir, `${image}.${arch}`))
		.filter((file) => fs.existsSync(file))
		.map(
			(file) =>
				`${IMAGE_REGISTRY_PREFIX}${image}@${fs.readFileSync(file, "utf8").trim()}`,
		)
	if (refs.length === 0) {
		throw new Error(`no per-arch digests for ${image} in ${digestsDir}`)
	}
	const tags = [imageRef(image, version), imageRef(image, "latest")]
	log(`${image}: joining ${refs.length} digest(s) → :${version} + :latest`)
	return spawnInherit("docker", [
		"buildx",
		"imagetools",
		"create",
		...tags.flatMap((tag) => ["--tag", tag]),
		...refs,
	])
}

async function main(): Promise<void> {
	const args = process.argv.slice(2)
	const command = args[0]
	if (command === "list") {
		runList()
		return
	}
	if (command === "bake") {
		const version = args[1]
		const arch = args[2]
		if (
			version === undefined ||
			!VERSION_RE.test(version) ||
			arch === undefined ||
			!ARCH_RE.test(arch)
		) {
			console.error("Usage: build-images.ts bake <version> <amd64|arm64>")
			process.exitCode = 1
			return
		}
		runBake(version, arch)
		return
	}
	if (command === "execute") {
		const version = args[1]
		if (version === undefined || !VERSION_RE.test(version)) {
			console.error("Usage: build-images.ts execute <version>")
			process.exitCode = 1
			return
		}
		await runExecute(version)
		return
	}
	if (command === "emit-digests") {
		const metadataFile = args[1]
		const dir = args[2]
		const arch = args[3]
		if (
			metadataFile === undefined ||
			dir === undefined ||
			arch === undefined ||
			!ARCH_RE.test(arch)
		) {
			console.error(
				"Usage: build-images.ts emit-digests <metadata-file> <dir> <amd64|arm64>",
			)
			process.exitCode = 1
			return
		}
		runEmitDigests(metadataFile, dir, arch)
		return
	}
	if (command === "manifest") {
		const image = args[1]
		const version = args[2]
		const digestsDir = args[3]
		if (
			image === undefined ||
			version === undefined ||
			!VERSION_RE.test(version) ||
			digestsDir === undefined
		) {
			console.error("Usage: build-images.ts manifest <image> <version> <digests-dir>")
			process.exitCode = 1
			return
		}
		await runManifest(image, version, digestsDir)
		return
	}
	console.error(
		"Usage:\n" +
			"  node --import tsx scripts/build-images.ts list\n" +
			"  node --import tsx scripts/build-images.ts bake <version> <amd64|arm64>\n" +
			"  node --import tsx scripts/build-images.ts execute <version>\n" +
			"  node --import tsx scripts/build-images.ts emit-digests <metadata-file> <dir> <amd64|arm64>\n" +
			"  node --import tsx scripts/build-images.ts manifest <image> <version> <digests-dir>",
	)
	process.exitCode = 1
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
})
