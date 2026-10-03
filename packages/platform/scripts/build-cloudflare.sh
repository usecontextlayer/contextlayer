#!/usr/bin/env bash
set -euo pipefail

mkdir -p bin
curl -fsSL --tlsv1.2 --proto '=https' https://cli.doppler.com/install.sh | sh -s -- --install-path "$PWD/bin"

export FONTAWESOME_PACKAGE_TOKEN
FONTAWESOME_PACKAGE_TOKEN=$(bin/doppler secrets get FONTAWESOME_PACKAGE_TOKEN --plain --project platform --config prod)
NPM_CONFIG_USERCONFIG="$PWD/packages/platform/scripts/ci.npmrc" pnpm install --frozen-lockfile
unset FONTAWESOME_PACKAGE_TOKEN

pnpm exec turbo run build --filter="${1:-@usecontextlayer/platform}"
