#!/usr/bin/env bash
# Run by the `web` service in compose.yaml. Starts the Vite dev server bound
# to 0.0.0.0 so the host can reach http://localhost:5173. HMR works against
# the bind-mounted source tree.
set -euo pipefail

cd /app/apps/web

echo "[web] starting vite on 0.0.0.0:5173..."
exec npx --no-install vite --host 0.0.0.0 --port 5173 --strictPort
