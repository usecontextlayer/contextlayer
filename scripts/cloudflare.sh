#!/usr/bin/env bash
set -euo pipefail

phase=${1:?Usage: bash scripts/cloudflare.sh build|deploy platform|dispatcher|auth|build [--dry-run]}
package=${2:?Specify platform, dispatcher, auth, or build}
shift 2

case "$package" in
  platform|dispatcher|auth|build) ;;
  *) echo "Unknown Worker package: $package" >&2; exit 1 ;;
esac

cd "$(dirname "${BASH_SOURCE[0]}")/.."

case "$phase" in
  build)
    mkdir -p bin
    curl -fsSL --tlsv1.2 --proto '=https' https://cli.doppler.com/install.sh | sh -s -- --install-path "$PWD/bin"

    export FONTAWESOME_PACKAGE_TOKEN
    FONTAWESOME_PACKAGE_TOKEN=$(bin/doppler secrets get FONTAWESOME_PACKAGE_TOKEN --plain --project platform --config prod)
    NPM_CONFIG_USERCONFIG="$PWD/scripts/ci.npmrc" pnpm install --frozen-lockfile
    unset FONTAWESOME_PACKAGE_TOKEN

    pnpm exec turbo run build --filter="@usecontextlayer/$package"
    ;;
  deploy)
    case "$*" in
      ""|--dry-run) ;;
      *) echo "Deploy accepts only the optional Wrangler --dry-run flag" >&2; exit 1 ;;
    esac
    secrets_file=$(mktemp)
    trap 'rm -f "$secrets_file"' EXIT

    bin/doppler secrets download --no-file --format json --project platform --config prod |
      pnpm --dir "packages/$package" exec node --input-type=module -e '
        import { writeFileSync } from "node:fs";
        import { unstable_readConfig } from "wrangler";

        const config = unstable_readConfig({ env: "" }, { useRedirectIfAvailable: true });
        let input = "";
        for await (const chunk of process.stdin) input += chunk;
        const values = JSON.parse(input);
        const secrets = Object.fromEntries(config.secrets.required.map((name) => {
          if (typeof values[name] !== "string" || values[name].length === 0) {
            throw new Error(`Missing required Doppler secret: ${name}`);
          }
          return [name, values[name]];
        }));
        writeFileSync(process.argv[1], JSON.stringify(secrets), { mode: 0o600 });
      ' "$secrets_file"

    pnpm --dir "packages/$package" exec wrangler deploy --env="" --secrets-file "$secrets_file" "$@"
    ;;
  *) echo "Unknown Cloudflare phase: $phase" >&2; exit 1 ;;
esac
