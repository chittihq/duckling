#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCH_FILE="${PEERDB_PATCH_FILE:-${ROOT_DIR}/docs/peerdb-upstream-zero-date-poc-v3.patch}"
WORK_DIR="${PEERDB_SRC_DIR:-${ROOT_DIR}/.tmp/peerdb-src}"
REPO_URL="${PEERDB_REPO_URL:-https://github.com/PeerDB-io/peerdb.git}"
# Pin the EXACT upstream commit — never a branch (main/dev move on every push)
# and not even a release tag (a tag can be re-pointed or deleted upstream).
# An immutable SHA means upstream backend changes can never silently alter what
# we build. If you bump this, the v3 patch may stop applying cleanly — that is a
# LOUD, intended failure (git apply aborts), not a silent behavior change, so
# re-verify the patch + run tests/peerdb/run-type-coverage.sh before shipping.
# 34ecaea = release tag v0.36.19 (matches stable-v0.36.19 in the compose file).
PEERDB_COMMIT="${PEERDB_REPO_REF:-34ecaea70a6dd36dbd99cceb4701685cc914b631}"

FLOW_API_IMAGE="${PEERDB_FLOW_API_IMAGE_TAG:-duckling-peerdb-flow-api:zero-date-v3}"
FLOW_WORKER_IMAGE="${PEERDB_FLOW_WORKER_IMAGE_TAG:-duckling-peerdb-flow-worker:zero-date-v3}"
FLOW_SNAPSHOT_IMAGE="${PEERDB_FLOW_SNAPSHOT_WORKER_IMAGE_TAG:-duckling-peerdb-flow-snapshot-worker:zero-date-v3}"

log() { echo "[$(date +%H:%M:%S)] $*"; }

if [[ ! -f "${PATCH_FILE}" ]]; then
  echo "Patch file not found: ${PATCH_FILE}" >&2
  exit 1
fi

mkdir -p "$(dirname "${WORK_DIR}")"

# Fetch the pinned commit directly (GitHub allows fetching a reachable SHA).
# This path is identical for a fresh clone and a reused checkout, and the tag
# bug it replaces — `reset --hard origin/<tag>`, which never resolves because
# tags are not remote-tracking branches — is gone.
if [[ ! -d "${WORK_DIR}/.git" ]]; then
  log "Initialising PeerDB checkout at ${WORK_DIR}"
  git init -q "${WORK_DIR}"
  git -C "${WORK_DIR}" remote add origin "${REPO_URL}"
fi

log "Fetching pinned PeerDB commit ${PEERDB_COMMIT}"
git -C "${WORK_DIR}" fetch --depth 1 origin "${PEERDB_COMMIT}"
git -C "${WORK_DIR}" -c advice.detachedHead=false checkout --force --detach FETCH_HEAD
# Drop any leftover patch edits / generated files so the patch applies to a
# pristine tree every time.
git -C "${WORK_DIR}" clean -fdx

# Guard: fail loudly if we did not land exactly on the pinned commit. Only
# enforced when the pin is a full SHA — an explicit PEERDB_REPO_REF override to
# a tag/branch is the caller deliberately opting out of immutable pinning.
ACTUAL_COMMIT="$(git -C "${WORK_DIR}" rev-parse HEAD)"
if [[ "${PEERDB_COMMIT}" =~ ^[0-9a-f]{40}$ && "${ACTUAL_COMMIT}" != "${PEERDB_COMMIT}" ]]; then
  echo "Pinned PeerDB commit ${PEERDB_COMMIT} but checkout landed on ${ACTUAL_COMMIT}" >&2
  exit 1
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
