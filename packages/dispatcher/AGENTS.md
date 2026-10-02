# Dispatcher

Use Wrangler for this Worker, as explicitly approved alongside `packages/build`. The platform owns the hostname-to-AppID mapping. Resolve the incoming hostname through its OpenAPI endpoint, validate the response with Zod, and forward the original request using the native dispatch namespace binding. The AppID is the WfP Worker name. Do not add a local mapping, cache, or database connection.

`CTX_PLATFORM_URL` points to the platform. The current development setup uses a user-approved ngrok tunnel; both the local platform and tunnel must be running. Use `env.ts` for environment-variable validation. Authentication and deployment-on-push are separate milestones.
