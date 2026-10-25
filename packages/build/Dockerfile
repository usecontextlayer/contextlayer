FROM docker.io/cloudflare/sandbox:0.12.1
RUN npm install --global pnpm@11.22.0
COPY --from=docker.io/rclone/rclone:1.75.2 /usr/local/bin/rclone /usr/local/bin/rclone
RUN mkdir -p /opt/contextlayer && pnpm --dir /opt/contextlayer add --save-exact --allow-build=esbuild --allow-build=workerd wrangler@4.152.0
