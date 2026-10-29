FROM docker.io/cloudflare/sandbox:0.12.1

# The sandbox server pre-spawns three idle executors per language for its code interpreter. Builds and
# migrations only run commands, so start none. The 0.12.1 server reads these variables here:
# https://github.com/cloudflare/sandbox-sdk/blob/48f3f4f72b8777f3969f6ff033e4b227df930de5/packages/sandbox-container/src/runtime/process-pool.ts#L179
ENV JAVASCRIPT_POOL_MIN_SIZE=0 PYTHON_POOL_MIN_SIZE=0 TYPESCRIPT_POOL_MIN_SIZE=0

COPY --from=docker.io/rclone/rclone:1.75.2 /usr/local/bin/rclone /usr/local/bin/rclone
COPY --from=docker.io/node:22.23.4-bookworm-slim /usr/local/bin/node /usr/local/bin/node

RUN npm install --global pnpm@11.22.0
RUN mkdir -p /opt/contextlayer && pnpm --dir /opt/contextlayer add --save-exact --allow-build=esbuild --allow-build=workerd wrangler@4.152.0
