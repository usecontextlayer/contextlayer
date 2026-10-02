# Build Worker

This package runs the Artifacts push-to-build pipeline on Cloudflare. Extend `CIWorkflow` from `@cloudflare/ci` and use its native runners, checkout, snapshots, and reporting. The pipeline chains an install/build runner to a deploy runner using the SDK snapshot. The deploy runner invokes Wrangler for both server code and static assets, using the repository AppID as the Worker name in the contextlayer-dev dispatch namespace. There is no ContextLayer build UI.

Use Wrangler for this package’s build and deployment. This is an explicitly approved exception to the workspace’s `cf` convention because `cloudflare.config.ts` does not yet support Artifacts event triggers. Keep the trigger and resource declarations together in `wrangler.jsonc`.

The R2 credentials in `.dev.vars` are local secrets, ignored by Git. Never print or commit them. Runtime variables and bindings belong in the Wrangler configuration; the CI SDK consumes them directly. Build commands receive no Cloudflare deployment credential. The deploy runner opts into the SDK’s `cloudflareCredentials` capability, which reads the `CF_TOKEN` Worker secret.
