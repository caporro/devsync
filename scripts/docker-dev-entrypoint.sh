#!/bin/sh
set -eu

# Each service installs its own package into its Docker node_modules volume.
# Include the runtime/architecture so cached native modules are refreshed too.
dependency_fingerprint="$(node --version)
$(uname -sm)
$(sha256sum package.json package-lock.json)"
dependency_stamp="node_modules/.devsync-install-state"

if [ ! -f "$dependency_stamp" ] || [ "$(cat "$dependency_stamp")" != "$dependency_fingerprint" ]; then
  npm ci --include=dev --no-audit --no-fund
  printf '%s\n' "$dependency_fingerprint" > "$dependency_stamp"
fi

exec "$@"
