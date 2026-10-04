#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
if [[ ! -f .env ]]; then cp ubuntu/.env.ubuntu.example .env; chmod 600 .env; fi
if [[ ! -d node_modules || ! -f client/dist/index.html ]]; then
  printf '%s\n' 'Run bash ubuntu/setup.sh first.' >&2
  exit 1
fi
exec npm run start
