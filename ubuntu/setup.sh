#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
if ! command -v node >/dev/null || (( $(node -p 'Number(process.versions.node.split(".")[0])') < 24 )); then
  printf '%s\n' 'Install Node.js 24 or newer, then run bash ubuntu/setup.sh.' >&2
  exit 1
fi
if [[ ! -f .env ]]; then cp ubuntu/.env.ubuntu.example .env; chmod 600 .env; fi
npm ci
npm run build
printf '%s\n' 'ZDIS is ready. Run bash ubuntu/start.sh. The first startup generates an administrator password.'
