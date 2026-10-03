#!/usr/bin/env bash
set -euo pipefail

secrets_file=$(mktemp)
trap 'rm -f "$secrets_file"' EXIT
bin/doppler secrets download --no-file --format json --project platform --config prod |
  node --input-type=module -e '
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const { CTX_PLATFORM_DATABASE_URL, COMPOSIO_API_KEY } = JSON.parse(input);
    process.stdout.write(JSON.stringify({ CTX_PLATFORM_DATABASE_URL, COMPOSIO_API_KEY }));
  ' > "$secrets_file"

pnpm --dir packages/platform exec wrangler deploy --config build/server/wrangler.json --secrets-file "$secrets_file"
