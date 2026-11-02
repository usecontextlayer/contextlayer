# Build Worker

Follow the [domain model](../../ARCHITECTURE.md#domain-model) and [build pipeline](../../ARCHITECTURE.md#build-pipeline) for ownership, phase ordering and credential boundaries. Extend `CIWorkflow` from `@cloudflare/ci`; use its native checkout, runners and snapshots. Own publication through a normal Workflow step and the native Sandbox lifecycle. Each publishing attempt must destroy its Sandbox when finished.

## Migration runner

Implement the [shared migration phase](../../ARCHITECTURE.md#slate-databases-and-authored-migrations) once for build and member provisioning. Disable automatic retries and output snapshots. For each nonempty provisioning operation, use one sandbox and prepare its workspace once: restore the supplied build snapshot or install dependencies once, then run the native Kysely CLI sequentially against the selected database targets and stop on the first failure. Reuse the initiating operation's revision and prepared instance set; the runner must not select new actors, resources or source.

Host native migration sandboxes in the existing `CiSandbox` namespace and expose the SDK's `ContainerProxy`. Register handlers by assigning `CiSandbox.outboundHandlers`, which invokes the native registry setter. Map each selected database instance to a distinct trusted virtual hostname. The outbound SQL handler uses only that per-run mapping and the `DATABASES` binding; authored requests supply SQL and parameters, never physical database identity. Do not route migration SQL through the viewer-delegated runtime query operation: that operation can itself initiate membership. Preserve SQL errors across the HTTP boundary so the native Kysely CLI fails visibly.

## Publication

Run normal frozen installation and the authored build. Native Vite/framework configuration must place the deployment output under build/. Transfer build/ and .wrangler/deploy/ with image-owned rclone, preserving their project-relative paths. Do not parse the generated configuration to discover or copy individual output directories, reconstruct it, or introduce another artifact manifest.

In the fresh publisher, download into a payload child of the clean execution root without restoring links. Run the pinned image-owned Wrangler by absolute path from that payload root, so Wrangler follows .wrangler/deploy/config.json itself. Supply the canonical SlateID, dispatch namespace and commit tag through native deployment options. Keep the generated configuration and outputs unchanged during transfer and publication. The [build pipeline](../../ARCHITECTURE.md#build-pipeline) owns the current trust in authored configuration and the planned resource-isolation restriction.

No CI runner may opt into `cloudflareCredentials`. Scope deployment credentials to the image-owned Wrangler invocation after the download. Keep the parent R2 credential pair in the trusted Worker and derive temporary transfer credentials with Cloudflare's native prefix and permission scopes. Never print or commit credentials, including temporary session tokens.

## Native inspection

Keep native instance-detail reads internal to list ownership selection under the [inspection contract](../../ARCHITECTURE.md#slate-build-inspection). Return selected native LIST rows rather than constructing public responses from detail records, and keep private record bodies out of failure responses. Adding a route or broadening an upstream read requires reviewing that disclosure boundary; masking known strings cannot make arbitrary step output safe.

## Deployment configuration

Use the [shared service deployment workflow](../../DEVELOPING.md#service-deployment) for this Worker. Keep the Artifacts trigger, bindings, and runtime secret names in `wrangler.jsonc`.

Building the configured Sandbox image requires Docker. The production Artifacts namespace, dispatch namespace and R2 bucket must exist before slate deployment. The `contextlayer-build-backups` R2 bucket holds CI build snapshots and compiled deployment folders under separate prefixes. Configure bucket-scoped Object Read & Write credentials as `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, and the authored-slate Workers deployment API token as `CF_TOKEN`, in Doppler `platform/prod`. Follow the root [Build prerequisites](../../DEVELOPING.md#build-worker) for deployment ordering and cross-Worker bindings, and [Slate deployment](../../DEVELOPING.md#slate-deployment) to inspect builds and membership provisioning.

## Artifact verification

When changing publication, follow [artifact verification and resource ownership](../../TESTING.md#fixtures-and-resource-ownership): exercise the production transfer and publisher, keep credential/configuration assertions in Build's tests, and verify effective Cloudflare bindings rather than relying on upload metadata alone. [Cloudflare test prerequisites](../../TESTING.md#cloudflare-test-resources) owns test-bucket credentials and remote-resource setup.
