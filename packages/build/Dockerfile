FROM docker.io/cloudflare/sandbox:0.12.1
RUN npm install --global pnpm@11.22.0
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
RUN python3 -c 'from tarfile import data_filter'
RUN mkdir -p /opt/contextlayer && pnpm --dir /opt/contextlayer add --save-exact --allow-build=esbuild --allow-build=workerd wrangler@4.152.0
COPY prepare-artifact.py /opt/contextlayer/prepare-artifact.py
