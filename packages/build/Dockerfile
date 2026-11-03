ARG PREFETCH_TEMPLATE_DEPENDENCIES=false
FROM docker.io/cloudflare/sandbox:0.12.14 AS prefetch-false

# The sandbox server pre-spawns three idle executors per language for its code interpreter. Builds and
# migrations only run commands, so start none. The 0.12.14 server reads these variables here:
# https://github.com/cloudflare/sandbox-sdk/blob/b96de6ea1ca248e11a56a78f1efabc2717d6c7b9/packages/sandbox-container/src/runtime/process-pool.ts#L179
ENV JAVASCRIPT_POOL_MIN_SIZE=0 PYTHON_POOL_MIN_SIZE=0 TYPESCRIPT_POOL_MIN_SIZE=0

COPY --from=docker.io/rclone/rclone:1.75.2 /usr/local/bin/rclone /usr/local/bin/rclone
COPY --from=docker.io/node:22.23.4-bookworm-slim /usr/local/bin/node /usr/local/bin/node

RUN npm install --global pnpm@11.22.0
RUN mkdir -p /opt/contextlayer && pnpm --dir /opt/contextlayer add --save-exact --allow-build=esbuild --allow-build=workerd wrangler@4.152.0

# A shell condition cannot remove bind-mount inputs; exclude them through stage selection.
FROM prefetch-false AS prefetch-true
# A tmpfs project would also put pnpm's store on tmpfs; only node_modules is disposable.
RUN --mount=type=tmpfs,target=/tmp/template/node_modules \
    --mount=type=bind,source=pnpm-lock.yaml,target=/tmp/template/pnpm-lock.yaml \
    --mount=type=bind,source=pnpm-workspace.yaml,target=/tmp/template/pnpm-workspace.yaml \
    pnpm --dir /tmp/template fetch

FROM prefetch-${PREFETCH_TEMPLATE_DEPENDENCIES}
