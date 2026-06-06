#!/usr/bin/env bash
#
# Safe bring-up for the PeerDB stack.
#
# Guarantees the zero-date-safe flow images are present (building them from
# source on first run), then runs docker compose with those images pinned.
#
# Use this INSTEAD of a bare `docker compose -f docker-compose.peerdb.yml up`.
# The bare command uses stock upstream PeerDB images, which corrupt MySQL
# zero-dates (0000-00-00 -> 1970-01-01) on the ClickHouse path. See
# docs/peerdb-upstream-zero-date-patch.md.
#
# Usage:
#   scripts/peerdb-up.sh                 # up -d (default)
#   scripts/peerdb-up.sh up -d flow-api  # any docker compose args pass through
#   scripts/peerdb-up.sh down -v
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Builds the patched images if absent and exports PEERDB_FLOW_*_IMAGE.
# shellcheck source=ensure-peerdb-zero-date-images.sh
source "${ROOT_DIR}/scripts/ensure-peerdb-zero-date-images.sh"

args=("$@")
if [[ ${#args[@]} -eq 0 ]]; then
  args=(up -d)
fi

exec docker compose -f "${ROOT_DIR}/docker-compose.peerdb.yml" "${args[@]}"
