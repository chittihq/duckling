#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCH_FILE="${PEERDB_PATCH_FILE:-${ROOT_DIR}/docs/peerdb-upstream-zero-date-poc-v3.patch}"
WORK_DIR="${PEERDB_SRC_DIR:-${ROOT_DIR}/.tmp/peerdb-src}"
REPO_URL="${PEERDB_REPO_URL:-https://github.com/PeerDB-io/peerdb.git}"
# v3 patch is written against v0.36.19 (the tag behind the
# stable-v0.36.19 images pinned in docker-compose.peerdb.yml).
REPO_REF="${PEERDB_REPO_REF:-v0.36.19}"

FLOW_API_IMAGE="${PEERDB_FLOW_API_IMAGE_TAG:-duckling-peerdb-flow-api:zero-date-v3}"
FLOW_WORKER_IMAGE="${PEERDB_FLOW_WORKER_IMAGE_TAG:-duckling-peerdb-flow-worker:zero-date-v3}"
FLOW_SNAPSHOT_IMAGE="${PEERDB_FLOW_SNAPSHOT_WORKER_IMAGE_TAG:-duckling-peerdb-flow-snapshot-worker:zero-date-v3}"

log() { echo "[$(date +%H:%M:%S)] $*"; }

if [[ ! -f "${PATCH_FILE}" ]]; then
  echo "Patch file not found: ${PATCH_FILE}" >&2
  exit 1
fi

mkdir -p "$(dirname "${WORK_DIR}")"

if [[ ! -d "${WORK_DIR}/.git" ]]; then
  log "Cloning PeerDB into ${WORK_DIR}"
  git clone --depth 1 --branch "${REPO_REF}" "${REPO_URL}" "${WORK_DIR}"
else
  log "Reusing existing PeerDB checkout at ${WORK_DIR}"
  git -C "${WORK_DIR}" fetch --depth 1 origin "${REPO_REF}"
  git -C "${WORK_DIR}" reset --hard "origin/${REPO_REF}"
  git -C "${WORK_DIR}" clean -fd
fi

log "Applying zero-date proof-of-concept patch: ${PATCH_FILE}"
git -C "${WORK_DIR}" apply --reject --whitespace=fix "${PATCH_FILE}"

log "Generating PeerDB protobuf outputs"
if command -v buf >/dev/null 2>&1; then
  (
    cd "${WORK_DIR}" && buf generate --template buf.gen.yaml protos
  )
else
  if [[ "${DOCKER_HOST:-}" == ssh://* ]]; then
    cat <<EOF >&2
buf is not installed locally, and DOCKER_HOST points at a remote daemon.
The dockerized buf fallback cannot mount the local checkout into a remote container.

Install buf locally and rerun:
  https://buf.build/docs/installation
EOF
    exit 1
  fi
  docker run --rm \
    -v "${WORK_DIR}:/workspace" \
    -w /workspace \
    bufbuild/buf:1.58.0 \
    generate --template buf.gen.yaml protos
fi

log "Building patched flow-api image: ${FLOW_API_IMAGE}"
docker build \
  -f "${WORK_DIR}/stacks/flow.Dockerfile" \
  --target flow-api \
  -t "${FLOW_API_IMAGE}" \
  "${WORK_DIR}"

log "Building patched flow-worker image: ${FLOW_WORKER_IMAGE}"
docker build \
  -f "${WORK_DIR}/stacks/flow.Dockerfile" \
  --target flow-worker \
  -t "${FLOW_WORKER_IMAGE}" \
  "${WORK_DIR}"

log "Building patched flow-snapshot-worker image: ${FLOW_SNAPSHOT_IMAGE}"
docker build \
  -f "${WORK_DIR}/stacks/flow.Dockerfile" \
  --target flow-snapshot-worker \
  -t "${FLOW_SNAPSHOT_IMAGE}" \
  "${WORK_DIR}"

cat <<EOF

Patched PeerDB images built successfully.

Set these environment variables before running docker-compose.peerdb.yml:

  export PEERDB_FLOW_API_IMAGE='${FLOW_API_IMAGE}'
  export PEERDB_FLOW_WORKER_IMAGE='${FLOW_WORKER_IMAGE}'
  export PEERDB_FLOW_SNAPSHOT_WORKER_IMAGE='${FLOW_SNAPSHOT_IMAGE}'

If you are using a remote Docker daemon, run this script with the same DOCKER_HOST.
EOF
