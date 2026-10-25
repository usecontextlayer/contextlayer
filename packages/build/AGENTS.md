# Build Worker

Follow the [domain model](../../ARCHITECTURE.md#domain-model) and [build pipeline](../../ARCHITECTURE.md#build-pipeline) for ownership, phase ordering and credential boundaries. Extend `CIWorkflow` from `@cloudflare/ci`; use its native checkout, runners and snapshots. Own publication through a normal Workflow step and the native Sandbox lifecycle. Each publishing attempt must destroy its Sandbox when finished.

Keep publishing tools in the platform image and invoke its pinned Wrangler by absolute path with an explicit config and `--no-bundle`. Do not discover tools or configuration from artifact contents. Materialize artifacts in a separate directory with native `tarfile.data_filter`; reject links and special files so authored paths cannot replace platform tools. Keep source-map discovery disabled during publication; artifact-controlled paths must not make publishing tools read outside the selected module tree. When changing Wrangler or artifact preparation, verify effective bindings on Cloudflare as well as the serialized upload: upload metadata alone does not establish the resulting binding state.

Use the shared repository-root `scripts/cloudflare.sh` build/deploy phases for deployment of this Worker, matching platform, dispatcher, and auth. Keep the Artifacts trigger, bindings, and runtime secret names in `wrangler.jsonc`; use native `secrets.required` for the secret names and Doppler for their values. Do not add package-specific deployment scripts or a `.dev.vars` deployment copy.

Keep `env.test` free of an Artifacts push subscription. Its `BACKUP_BUCKET` must address the same remote bucket as snapshot upload, or upload verification and restoration will read a different store. [Platform test guidance](../platform/AGENTS.md#slate-build-verification) owns live pipeline prerequisites and commands.

No CI runner may opt into `cloudflareCredentials`. Scope deployment credentials to the image-owned Wrangler command after artifact preparation. Treat presigned URLs as credentials too; never print or commit them.

Host native migration sandboxes in the existing `CiSandbox` namespace and expose the SDK's `ContainerProxy`. Register handlers by assigning `CiSandbox.outboundHandlers`, which invokes the native registry setter. Platform invokes that namespace through a cross-Worker Durable Object binding. The sandbox's outbound SQL handler uses only its trusted per-run instance selection and the `DATABASES` binding; authored requests supply SQL and parameters, never physical database identity. Preserve SQL errors across the HTTP boundary so the native Kysely CLI fails visibly.

## Artifact verification

Run `pnpm exec turbo run tsc test build --filter=@usecontextlayer/build` from the repository root. Unit tests require Python 3 with `tarfile.data_filter`; building the Sandbox image also requires Docker.
