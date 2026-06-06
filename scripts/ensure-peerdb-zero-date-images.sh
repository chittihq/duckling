#!/usr/bin/env bash
#
# Ensure the zero-date-safe PeerDB flow images exist locally, building them
# from source (via build-peerdb-zero-date-poc.sh) when any are absent.
#
# Idempotent: a no-op once the three images are built. Designed to be either
# run directly or `source`d — when sourced it also exports the three
# PEERDB_FLOW_*_IMAGE vars so a following `docker compose` picks them up.
#
# Why this exists: stock upstream PeerDB v0.36 corrupts MySQL zero-dates
# (0000-00-00 -> 1970-01-01) on the ClickHouse path. The patched images apply
# docs/peerdb-upstream-zero-date-poc-v3.patch, which converts zero/partial-zero
# dates to NULL. See docs/peerdb-upstream-zero-date-patch.md.
set -euo pipefail

_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Default to the verified v3 tags; allow override so the same machinery can
# build/point at a different tag if needed.
PEERDB_FLOW_API_IMAGE="${PEERDB_FLOW_API_IMAGE:-duckling-peerdb-flow-api:zero-date-v3}"
PEERDB_FLOW_WORKER_IMAGE="${PEERDB_FLOW_WORKER_IMAGE:-duckling-peerdb-flow-worker:zero-date-v3}"
PEERDB_FLOW_SNAPSHOT_WORKER_IMAGE="${PEERDB_FLOW_SNAPSHOT_WORKER_IMAGE:-duckling-peerdb-flow-snapshot-worker:zero-date-v3}"

_missing=0
for _img in "$PEERDB_FLOW_API_IMAGE" "$PEERDB_FLOW_WORKER_IMAGE" "$PEERDB_FLOW_SNAPSHOT_WORKER_IMAGE"; do
  if ! docker image inspect "$_img" >/dev/null 2>&1; then
    echo "[peerdb] zero-date-safe image missing: $_img" >&2
    _missing=1
  fi
done

if [[ "$_missing" -eq 1 ]]; then
  echo "[peerdb] building zero-date-safe PeerDB images from source (first run only; this is slow)..." >&2
  PEERDB_FLOW_API_IMAGE_TAG="$PEERDB_FLOW_API_IMAGE" \
  PEERDB_FLOW_WORKER_IMAGE_TAG="$PEERDB_FLOW_WORKER_IMAGE" \
  PEERDB_FLOW_SNAPSHOT_WORKER_IMAGE_TAG="$PEERDB_FLOW_SNAPSHOT_WORKER_IMAGE" \
    "${_ROOT_DIR}/scripts/build-peerdb-zero-date-poc.sh"
else
  echo "[peerdb] zero-date-safe images present; skipping build." >&2
fi

export PEERDB_FLOW_API_IMAGE PEERDB_FLOW_WORKER_IMAGE PEERDB_FLOW_SNAPSHOT_WORKER_IMAGE
