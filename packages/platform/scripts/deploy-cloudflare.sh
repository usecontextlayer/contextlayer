#!/usr/bin/env bash
set -euo pipefail

package=${1:-platform}

secrets_file=$(mktemp)
trap 'rm -f "$secrets_file"' EXIT
bin/doppler secrets download --no-file --format json --project platform --config prod |
  node --input-type=module -e '
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const { CTX_AUTH_ISSUER, CTX_PLATFORM_DATABASE_URL, CTX_CUSTOMER_CREDENTIALS_DOPPLER_PROJECT, CTX_CUSTOMER_CREDENTIALS_DOPPLER_CONFIG, CTX_CUSTOMER_CREDENTIALS_DOPPLER_TOKEN, COMPOSIO_API_KEY, POLAR_WEBHOOK_SECRET, POLAR_ACCESS_TOKEN, POLAR_ENVIRONMENT } = JSON.parse(input);
    const secrets = process.argv[1] === "dispatcher"
      ? { POLAR_ACCESS_TOKEN, POLAR_ENVIRONMENT }
      : { CTX_AUTH_ISSUER, CTX_PLATFORM_DATABASE_URL, CTX_CUSTOMER_CREDENTIALS_DOPPLER_PROJECT, CTX_CUSTOMER_CREDENTIALS_DOPPLER_CONFIG, CTX_CUSTOMER_CREDENTIALS_DOPPLER_TOKEN, COMPOSIO_API_KEY, POLAR_WEBHOOK_SECRET, POLAR_ACCESS_TOKEN, POLAR_ENVIRONMENT };
    process.stdout.write(JSON.stringify(secrets));
  ' "$package" > "$secrets_file"

if [[ "$package" == dispatcher ]]; then
  pnpm --dir packages/dispatcher exec wrangler deploy --secrets-file "$secrets_file"
else
  pnpm --dir packages/platform exec wrangler deploy --config build/server/wrangler.json --secrets-file "$secrets_file"
fi
