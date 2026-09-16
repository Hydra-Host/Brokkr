#!/usr/bin/env bash
# Sim hub-and-spoke e2e: the shipped docker-compose stack + one libvirt device VM,
# seeded hub, ts-e2e suites. Needs a KVM host with the devenv toolchain.
#
# Every host-global resource (ports, subnets, data bridge, domain names, compose
# projects, fleet state) is namespaced by SLOT (CI_CONCURRENT_ID) so concurrent jobs
# coexist; slot 0 == the historical values. Valid only with one sim runner per host.
#
# Usage: sim-e2e-hybrid.sh [provision|teardown]   (default: smoke)
#   SIM_KEEP_UP=1          leave the stack up on exit (debug)
#   SIM_SKIP_BUILD=1       reuse existing local images
#   SIM_PULL_IMAGES=1      pull this commit's release images (post-merge CI)
#   SIM_DISCOVERY_CACHE=<dir>  pre-staged discovery set; unset = sync from asset host
set -uo pipefail

REPO="${CI_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)}"
REGISTRY="${CI_REGISTRY:-registry.gitlab.com}"
# Image namespace: $CI_REGISTRY_IMAGE in CI, or SIM_IMAGE_NS for a local run. No
# hardcoded registry path here so this file stays clean for the public BOSS sync.
IMG_NS="${SIM_IMAGE_NS:-${CI_REGISTRY_IMAGE:-}}"
ZONE="${SIM_ZONE_ID:-00000000-0000-0000-0000-111111111111}"
# Local-sim device-secret key; stable per run. Override for a real deployment.
AT_REST="${BRIDGE_AT_REST_KEY:-I1GOxiD9hSt9QvHUdylUSXKW/WHM6PF2dUCovWeSTXg=}"
# Hub zone-crypto private key (base64). Keying the hub unlocks POST /enroll so the bridge
# self-enrolls its zone (S1 auth-DH) and BMC creds can seal — provision mode only. Committed
# NON-SECRET local-dev constant (see devenv/modules/zone-crypto.nix hubPrivateKey).
HUB_PRIVATE_KEY="${SIM_HUB_PRIVATE_KEY:-CLgn641z7sEoBORwcShY+RdjAUnrluM/y+dzOa3oEko=}"
# SSH key the bridge bakes into brokkr-live + the ts-e2e probe uses to reach the VM.
SIM_SSH_KEY="${SIM_SSH_KEY:-${HOME}/.ssh/id_ed25519}"
# Discovery-image sync source (provision mode only): the full 'brokkr-live' set;
# both flavors are published per arch under brokkr.assets.hydra.host.
LIVE_VERSION="${SIM_BROKKR_LIVE_VERSION:-1.1.8}"
DISCOVERY_BASE_URL="${SIM_DISCOVERY_BASE_URL:-https://brokkr.assets.hydra.host/brokkr-live}"
OS_LAYER_URL="${SIM_OS_LAYER_URL:-https://brokkr.assets.hydra.host/os-layers/blobs}"
HUB_DIR="${REPO}/deploy/docker-compose/hub"
BRIDGE_DIR="${REPO}/deploy/docker-compose/bridge"
# docker-container buildx driver (not the `docker` driver) so the sim can push a registry mode=max
# cache that survives the shared runner's BuildKit GC — otherwise the api/web layer cold-rebuilds
# (~3min) whenever GC evicted the local cache. Cost: a --load tarball export (~50s) per run.
SIM_BUILDX_BUILDER="${SIM_BUILDX_BUILDER:-sim-builder}"

# Gate color on CI too, not just a TTY: GitLab job logs are a pipe but render ANSI.
if [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ] && { [ -t 1 ] || [ -n "${CI:-}" ]; }; then
  C_RESET=$'\033[0m' C_DIM=$'\033[2m' C_STEP=$'\033[1;36m'
  C_OK=$'\033[1;32m' C_WARN=$'\033[1;33m' C_ERR=$'\033[1;31m'
else
  C_RESET='' C_DIM='' C_STEP='' C_OK='' C_WARN='' C_ERR=''
fi
_ts() { date -u '+%F %T'; }
log() { printf '%s[%sZ] sim-e2e:%s %s\n' "${C_DIM}" "$(_ts)" "${C_RESET}" "$*"; }
step() { printf '%s[%sZ] sim-e2e ▶ %s%s\n' "${C_STEP}" "$(_ts)" "$*" "${C_RESET}"; }
ok() { printf '%s[%sZ] sim-e2e ✓ %s%s\n' "${C_OK}" "$(_ts)" "$*" "${C_RESET}"; }
warn() { printf '%s[%sZ] sim-e2e ! %s%s\n' "${C_WARN}" "$(_ts)" "$*" "${C_RESET}"; }
err() { printf '%s[%sZ] sim-e2e ✗ %s%s\n' "${C_ERR}" "$(_ts)" "$*" "${C_RESET}"; }

# Runner concurrency slot (0..limit-1): the namespace key for everything host-global.
# Compose ports keep CI's own stride-1 space (hub 3000+SLOT, spoke 8000+SLOT, gRPC
# 9082+SLOT — equal to ports.nix only at slot 0), deliberately NOT the derivation's
# block bands; fleet topology (names/MACs/CIDRs/consoles) comes from the derivation.
# SIM_SLOT overrides for parallel local runs.
SLOT="${SIM_SLOT:-${CI_CONCURRENT_ID:-0}}"
case "${SLOT}" in
'' | *[!0-9]*)
  err "SIM_SLOT/CI_CONCURRENT_ID must be a non-negative integer (got '${SLOT}')"
  exit 1
  ;;
esac
if [ "${SLOT}" -gt 32 ]; then
  err "slot ${SLOT} out of range (0..32 — subnet octets 200+SLOT/105+SLOT must stay valid)"
  exit 1
fi
HUB_HOST_PORT=$((3000 + SLOT))
PG_HOST_PORT=$((5432 + SLOT))
REDIS_HOST_PORT=$((6379 + SLOT))
BRIDGE_PORT=$((8000 + SLOT))
GRPC_PORT=$((9082 + SLOT))
DATA_CIDR="192.168.$((200 + SLOT)).0/24"
# Matches the fleet-topology derivation's LOCAL_DATA_BRIDGE (br-brokkr / br-brokkr-s<SLOT>).
DATA_BRIDGE="br-brokkr"
[ "${SLOT}" -gt 0 ] && DATA_BRIDGE="br-brokkr-s${SLOT}"
# Data-plane gateway (the data bridge's host IP). The deployed OS phone-homes to the
# hub at this address, so the hub's BASE_URL must resolve here from inside the VM
# (localhost would be the VM itself). Default = this slot's subnet gateway.
DATA_GW="${SIM_DATA_GW:-192.168.$((200 + SLOT)).1}"
HUB_DSN="postgresql://thor:password@127.0.0.1:${PG_HOST_PORT}/thor"
FLEET_LOG="${REPO}/sim-fleet-s${SLOT}.log"
FLEET_PID="${REPO}/sim-fleet-s${SLOT}.pid"
# Domain-reap pattern for stop_stack: slotted fleets render s<SLOT>-cpu-* names; slot 0
# renders the legacy cpu-* names (no prefix), which can only belong to slot 0.
DOM_RE="^s${SLOT}-"
[ "${SLOT}" = 0 ] && DOM_RE="^(s0-|cpu-)"
# Local-only image tags (the registry only sees the buildcache refs). Slot-suffixed so one
# slot's teardown `image rm` can't race another slot's build→compose-up window when both
# run the SAME commit (smoke + manual provision E2E on one pipeline).
TAG="${SIM_IMAGE_TAG:-sim-${CI_COMMIT_SHORT_SHA:-local}-s${SLOT}}"

# shellcheck disable=SC1091
[ -e /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh ] &&
  . /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
export PATH="${HOME}/.nix-profile/bin:${PATH}"
# The project sets DOCKER_HOST to a DinD service for image-build jobs; the sim
# must use this host's local docker daemon (libvirt VMs + local containers).
export DOCKER_HOST="unix:///var/run/docker.sock"
# Sim/dev posture for the HOST-run devenv scripts (mint:sim-token, seed:sim-bmc). CI injects
# NODE_ENV=production (a group/runner-level default, not in .gitlab-ci.yml) into the job env, and
# devenv propagates it — tripping isLocalSimulationEnabled's NODE_ENV!==production gate so those
# scripts refuse to run and emit no token/secret. Force the dev posture here; the hub/bridge
# containers set their own env via compose env_file, so this governs only the host commands.
export NODE_ENV=development
export AUTH_BYPASS_ALLOWED_ENVS="${AUTH_BYPASS_ALLOWED_ENVS:-dev}"

# Slot-stable so warm artifacts (prefetch, iPXE builds) survive across runs. MUST stay
# under $HOME (sim-priv refuses ipmi_sim config dirs outside it); qemu's traversal into
# a 750 home is granted at bootstrap (chmod o+x).
LOCAL_STATE="${SIM_LOCAL_STATE:-${HOME}/.local/share/local-sim-s${SLOT}}"
# Prefixed into every devenv invocation: the python config defaults LOCAL_STATE/
# BRIDGE_ENDPOINT & friends to host-global values, and CI's stride-1 compose ports are
# deliberately NOT the devenv's block-band slot ports, so these must override inside the
# devenv shell. LOCAL_DATA_BRIDGE is deliberately absent: the stack.slot overlay in
# devenv.local.nix lets the derivation pin it (br-brokkr / br-brokkr-s<SLOT>).
SLOT_ENV="export LOCAL_STATE='${LOCAL_STATE}' \
BRIDGE_ENDPOINT='http://127.0.0.1:${BRIDGE_PORT}' BRIDGE_REDIS_URL='redis://127.0.0.1:${REDIS_HOST_PORT}' \
SIM_HUB_URL='http://127.0.0.1:${HUB_HOST_PORT}' SIM_BRIDGE_URL='http://127.0.0.1:${BRIDGE_PORT}' \
SIM_SLOT='${SLOT}';"

# Noble's libvirtd AppArmor profile denies exec of the nix-store qemu, so domains must
# use the apt emulator (EDK2 paths derive from it too). macOS runs keep autodetect.
if [ -x /usr/bin/qemu-system-x86_64 ]; then
  SLOT_ENV="${SLOT_ENV} export LOCAL_QEMU_EMULATOR=/usr/bin/qemu-system-x86_64;"
fi

denv() { (cd "${REPO}" && devenv shell -- bash -c "${SLOT_ENV} $1"); }

# Free THIS SLOT's environment (fleet VMs, containers, host ports) — safe pre-run and
# deliberately slot-scoped: a global sweep (`fleet nuke`'s tag sweep, a bare pkill on
# 'local.fleet up') would tear down concurrent jobs in other slots on the same host.
stop_stack() {
  # TERM the recorded fleet supervisor (its SIGTERM handler runs `fleet down`) …
  if [ -f "${FLEET_PID}" ]; then
    kill -TERM "$(cat "${FLEET_PID}")" 2>/dev/null || true
    sleep 3
    rm -f "${FLEET_PID}"
  fi
  # … then belt-and-braces: power off the staged fleet.yaml's nodes, and reap any
  # slot-prefixed domain a crashed prior run left behind (undefine frees the domain
  # name + NVRAM for the next run's define).
  denv "python -m local.fleet down" >/dev/null 2>&1 || true
  if command -v virsh >/dev/null 2>&1; then
    for dom in $(virsh -c qemu:///system list --all --name 2>/dev/null | grep -E "${DOM_RE}" || true); do
      virsh -c qemu:///system destroy "${dom}" >/dev/null 2>&1 || true
      virsh -c qemu:///system undefine "${dom}" --nvram >/dev/null 2>&1 || true
    done
  fi
  (cd "${BRIDGE_DIR}" && docker compose down -v) >/dev/null 2>&1 || true
  (cd "${HUB_DIR}" && docker compose down -v) >/dev/null 2>&1 || true
}

# Post-run only (exit trap + after_script): stop the stack, then scrub this run's built images and
# generated files (minted token, hub/bridge keys) so nothing leaks between runs.
# Deliberately NOT run pre-run — that would delete the images SIM_SKIP_BUILD reuses and wipe a prior
# run's config before an early exit could recreate it.
teardown() {
  log "teardown"
  stop_stack
  docker image rm -f "brokkr-app:${TAG}" "brokkr-bridge:${TAG}" >/dev/null 2>&1 || true
  # Cap the persistent sim-builder's internal store (MRU layers up to the cap survive, so the
  # just-pushed cache stays warm); without this it grows unbounded on the shared KVM host.
  # flock: slots share the builder — pruning while another slot builds would evict
  # layers mid-write, so skip (-n) when another teardown holds the lock.
  flock -n /tmp/sim-buildx-prune.lock \
    docker buildx prune --builder "${SIM_BUILDX_BUILDER}" --force --keep-storage 20GB >/dev/null 2>&1 || true
  sudo ip link del "${DATA_BRIDGE}" >/dev/null 2>&1 || true
  rm -f "${HUB_DIR}/.env" "${BRIDGE_DIR}/.env" "${BRIDGE_DIR}/docker-compose.override.yml" \
    "${REPO}/sim-zone-crypto.token" "${REPO}/sim-mint.err" "${REPO}/devenv.local.nix" \
    "${FLEET_PID}" >/dev/null 2>&1 || true
  # /opt/brokkr is deliberately NOT removed: it holds only nix-store symlinks the
  # devenv stages, and it is shared by every slot on the host.
}

# EXIT-trap variant only: SIM_KEEP_UP leaves the stack up so a failed interactive
# provision run can be inspected. CI never sets it, so CI still tears down.
teardown_on_exit() {
  if [ -n "${SIM_KEEP_UP:-}" ]; then
    warn "SIM_KEEP_UP set — leaving stack up (skipping exit teardown)"
    return 0
  fi
  teardown
}

wait_healthy() {
  local dir="$1" svc="$2" tries="${3:-40}" i st
  for ((i = 1; i <= tries; i++)); do
    st="$(cd "${dir}" && docker compose ps -a --format '{{.Service}} {{.Status}}' 2>/dev/null | grep "^${svc} " || true)"
    case "${st}" in
    *healthy*)
      ok "${svc} healthy"
      return 0
      ;;
    *Exited*)
      err "${svc} exited early:"
      (cd "${dir}" && docker compose logs "${svc}" --tail 40)
      return 1
      ;;
    esac
    sleep 5
  done
  err "${svc} not healthy after $((tries * 5))s"
  return 1
}

main() {
  if [ "${1:-}" = "teardown" ]; then
    teardown
    exit 0
  fi
  MODE="${1:-smoke}"
  trap teardown_on_exit EXIT
  stop_stack # free ports/VMs/containers from a prior run; images + generated files are scrubbed post-run

  if [ -z "${IMG_NS}" ]; then
    err "set CI_REGISTRY_IMAGE (CI) or SIM_IMAGE_NS (local run) to the image namespace"
    exit 1
  fi
  # DATA_GW, SIM_NAMESERVERS, HUB_PRIVATE_KEY and SIM_SSH_KEY are spliced into generated compose YAML and into
  # denv `bash -c` strings, so constrain their charsets to block quote/newline/shell-metacharacter
  # injection (and catch typos early). In normal use they are IPs / a base64 key, so the allowed
  # sets are narrow.
  case "${DATA_GW}" in
  '' | *[!0-9.]*)
    err "SIM_DATA_GW must be a bare IPv4 address (got '${DATA_GW}')"
    exit 1
    ;;
  esac
  case "${SIM_NAMESERVERS:-1.1.1.1}" in
  *[!0-9.,]*)
    err "SIM_NAMESERVERS must be comma-separated IPv4 addresses"
    exit 1
    ;;
  esac
  case "${HUB_PRIVATE_KEY}" in
  '' | *[!A-Za-z0-9+/=]*)
    err "SIM_HUB_PRIVATE_KEY must be a base64 value"
    exit 1
    ;;
  esac
  case "${ZONE}" in
  '' | *[!a-f0-9-]*)
    err "SIM_ZONE_ID must be a lowercase UUID (got '${ZONE}')"
    exit 1
    ;;
  esac
  case "${LIVE_VERSION}" in
  '' | *[!A-Za-z0-9._-]*)
    err "SIM_BROKKR_LIVE_VERSION must be alphanumeric with . _ - (got '${LIVE_VERSION}')"
    exit 1
    ;;
  esac
  case "${DISCOVERY_BASE_URL}" in
  '' | *[!A-Za-z0-9.:/_-]*)
    err "SIM_DISCOVERY_BASE_URL must be a plain URL (letters, digits, . : / _ -)"
    exit 1
    ;;
  esac
  case "${OS_LAYER_URL}" in
  '' | *[!A-Za-z0-9.:/_-]*)
    err "SIM_OS_LAYER_URL must be a plain URL (letters, digits, . : / _ -)"
    exit 1
    ;;
  esac
  case "${SIM_SSH_KEY}" in
  '' | *[!A-Za-z0-9/._-]*)
    err "SIM_SSH_KEY must be a filesystem path (letters, digits, / . _ -)"
    exit 1
    ;;
  esac
  case "${LOCAL_STATE}" in
  '' | *[!A-Za-z0-9/._-]*)
    err "SIM_LOCAL_STATE must be a filesystem path (letters, digits, / . _ -)"
    exit 1
    ;;
  esac
  # Fail fast if a pre-staged discovery cache is set but missing/empty: a short-form bind-mount of an
  # absent path makes Docker create an empty dir, so the bridge goes healthy with no discovery set and
  # provision fails late with an opaque SSH timeout. Provision-only: smoke never mounts the cache, so
  # a stray SIM_DISCOVERY_CACHE in the environment must not fail a smoke run (see PLA-745).
  if [ "${MODE}" = "provision" ] && [ -n "${SIM_DISCOVERY_CACHE:-}" ] && { [ ! -d "${SIM_DISCOVERY_CACHE}" ] || [ -z "$(ls -A "${SIM_DISCOVERY_CACHE}" 2>/dev/null)" ]; }; then
    err "SIM_DISCOVERY_CACHE='${SIM_DISCOVERY_CACHE}' is missing or empty — expected the pre-staged discovery set"
    exit 1
  fi
  log "repo=${REPO} images=${IMG_NS}/*:${TAG} mode=${MODE} slot=${SLOT} (ports ${HUB_HOST_PORT}/${BRIDGE_PORT}/${GRPC_PORT}, net ${DATA_CIDR})"
  if [ -n "${CI_JOB_TOKEN:-}" ]; then
    echo "${CI_JOB_TOKEN}" | docker login -u gitlab-ci-token --password-stdin "${REGISTRY}" >/dev/null || {
      err "docker login to ${REGISTRY} failed"
      return 1
    }
  fi

  # Slot overlay: the fleet renders from the slot derivation (one source of truth for slot
  # rules — names, MACs, CIDRs, console ports), not a staged-yaml rewrite. fleetNodeCount
  # pins 4 nodes at every slot (slots >=1 would otherwise default to a single node).
  FIRST_NODE="cpu-1"
  [ "${SLOT}" -gt 0 ] && FIRST_NODE="s${SLOT}-cpu-1"
  {
    echo '{ ... }:'
    echo '{'
    printf '  stack.slot = %s;\n' "${SLOT}"
    echo '  stack.fleetNodeCount = 4;'
    if [ "${MODE}" = "provision" ]; then
      # brokkr-live discovery copies the whole ISO into a RAM tmpfs; the amd64
      # full image (~5GB) blows past the 2GB node default, so give the first node headroom.
      printf '  fleet.zones."sim-zone".nodes."%s".memory_mb = %s;\n' "${FIRST_NODE}" "${SIM_NODE_MEMORY_MB:-12288}"
    fi
    echo '}'
  } >"${REPO}/devenv.local.nix"

  # Build ./packages/* (not just live-agent deps): the host-run sim scripts import
  # @repo/crypto + @repo/api-client whose exports resolve to dist/, which turbo's
  # dependsOn=^build alone doesn't produce. Deliberately broad in both modes — a
  # narrower filter would couple this harness to the ts-e2e helpers' import graph.
  step "workspace install + build workspace packages (@repo/* dist for the sim scripts) + live-agent"
  denv "pnpm install --frozen-lockfile \
    && pnpm --filter @repo/database db:generate \
    && pnpm turbo run build --filter='./packages/*' --filter=bridge-agent" || return 1

  if [ -n "${SIM_PULL_IMAGES:-}" ]; then
    # Post-merge mode: this pipeline's release builds already pushed the per-commit
    # images, so validate those exact bytes instead of rebuilding lookalikes.
    step "pull release images for ${CI_COMMIT_SHORT_SHA:-local} (pushed by this pipeline's release builds)"
    docker pull -q "${IMG_NS}/brokkr-app:${CI_COMMIT_SHORT_SHA:?SIM_PULL_IMAGES requires CI_COMMIT_SHORT_SHA}" || return 1
    docker pull -q "${IMG_NS}/brokkr-bridge:${CI_COMMIT_SHORT_SHA}" || return 1
    docker tag "${IMG_NS}/brokkr-app:${CI_COMMIT_SHORT_SHA}" "brokkr-app:${TAG}"
    docker tag "${IMG_NS}/brokkr-bridge:${CI_COMMIT_SHORT_SHA}" "brokkr-bridge:${TAG}"
  elif [ -n "${SIM_SKIP_BUILD:-}" ]; then
    warn "SIM_SKIP_BUILD set — reusing existing brokkr-app:${TAG} / brokkr-bridge:${TAG}"
  else
    step "build brokkr-app + brokkr-bridge from this checkout (the branch's live code)"
    docker buildx inspect "${SIM_BUILDX_BUILDER}" >/dev/null 2>&1 ||
      docker buildx create --name "${SIM_BUILDX_BUILDER}" --driver docker-container >/dev/null
    # Read our own :sim-buildcache first (kept fresh by cache-to below), fall back to the release
    # :buildcache; write :sim-buildcache mode=max so the next run's layers hit. ignore-error keeps a
    # cache-push hiccup (or a first run with no cache yet) from failing the build.
    docker buildx build --builder "${SIM_BUILDX_BUILDER}" --load -f apps/api/Dockerfile \
      --cache-from "type=registry,ref=${IMG_NS}/brokkr-app:sim-buildcache" \
      --cache-from "type=registry,ref=${IMG_NS}/brokkr-app:buildcache" \
      --cache-to "type=registry,ref=${IMG_NS}/brokkr-app:sim-buildcache,mode=max,ignore-error=true" \
      --build-arg "VERSION=${CI_COMMIT_SHORT_SHA:-sim-local}" \
      -t "brokkr-app:${TAG}" "${REPO}" || return 1
    docker buildx build --builder "${SIM_BUILDX_BUILDER}" --load -f apps/bridge/Dockerfile \
      --cache-from "type=registry,ref=${IMG_NS}/brokkr-bridge:sim-buildcache" \
      --cache-from "type=registry,ref=${IMG_NS}/brokkr-bridge:buildcache" \
      --cache-to "type=registry,ref=${IMG_NS}/brokkr-bridge:sim-buildcache,mode=max,ignore-error=true" \
      -t "brokkr-bridge:${TAG}" "${REPO}" || return 1
  fi

  step "hub up"
  sed "s|^BROKKR_APP_IMAGE=.*|BROKKR_APP_IMAGE=brokkr-app:${TAG}|" \
    "${HUB_DIR}/.env.example" >"${HUB_DIR}/.env"
  # Later duplicate keys win in an env_file, so this override wins over the
  # localhost BASE_URL in .env.example (see DATA_GW note above).
  printf 'BASE_URL=http://%s:%s\n' "${DATA_GW}" "${HUB_HOST_PORT}" >>"${HUB_DIR}/.env"
  # Compose-level vars (not app config): this slot's published host ports + the
  # project name that keeps its containers/volumes/networks distinct per slot.
  {
    printf 'COMPOSE_PROJECT_NAME=sim%s-hub\n' "${SLOT}"
    printf 'HUB_HOST_PORT=%s\n' "${HUB_HOST_PORT}"
    printf 'POSTGRES_HOST_PORT=%s\n' "${PG_HOST_PORT}"
    printf 'REDIS_HOST_PORT=%s\n' "${REDIS_HOST_PORT}"
  } >>"${HUB_DIR}/.env"
  # Key the hub (provision only): the zone-crypto S1 master switch. Unset ⇒ /enroll
  # returns 503, no enrollment, and the provision precondition fails "no usable BMC
  # credential". Appended after .env.example (which never sets it) so it takes effect.
  [ "${MODE}" = "provision" ] &&
    printf 'BROKKR_HUB_PRIVATE_KEY=%s\n' "${HUB_PRIVATE_KEY}" >>"${HUB_DIR}/.env"
  (cd "${HUB_DIR}" && docker compose up -d) || {
    err "hub compose up failed"
    return 1
  }
  wait_healthy "${HUB_DIR}" brokkr-hub || {
    err "hub not healthy — migrate logs (a failed migration leaves brokkr-hub stuck in Created):"
    (cd "${HUB_DIR}" && docker compose logs migrate --tail 40) 2>/dev/null
    return 1
  }

  # Stage fleet.yaml + seed the hub DB BEFORE the bridge starts: the bridge enrolls
  # cache-first at startup and consumes the registration token as leader (fresh Redis
  # has no cached zone_crypto), and the token is minted against the seeded Zone row —
  # so the Zone must exist and the token must be minted before the bridge comes up.
  log "bootstrap host paths the devenv DAG normally stages (fleet.yaml + /opt/brokkr)"
  { sudo mkdir -p /opt/brokkr && sudo chown "$(id -u):$(id -g)" /opt/brokkr; } || return 1
  # o+x (not o+r) on $HOME: libvirt's qemu user must traverse into the state dir to open
  # NVRAM/overlays (noble defaults homes to 750), while listing stays owner-only. The
  # state itself can't move out of $HOME — sim-priv's containment refuses foreign paths.
  if [ "$(uname -s)" = "Linux" ]; then
    sudo chmod o+x "${HOME}" || return 1
  fi
  # Force-copy: a stale staged fleet.yaml would mask topology overrides. The store source
  # already carries this slot's names/MACs/CIDRs/console ports via the overlay above.
  # SC2016: LOCAL_FLEET_* are devenv env vars — expand inside the devenv, not here.
  # shellcheck disable=SC2016
  denv 'mkdir -p "$(dirname "$LOCAL_FLEET_PATH")" && cp -f "$LOCAL_FLEET_SOURCE" "$LOCAL_FLEET_PATH"' || return 1

  step "seed zone + devices into the hub DB"
  # The VM reaches the bridge by IP; it needs DNS only for the OS-layer CDN during
  # deploy_os, and the bridge's own DNS isn't reliably on the gateway here (it starts
  # before the data bridge exists) — so point the VM's netplan at a public resolver.
  seed_ns=""
  [ "${MODE}" = "provision" ] && seed_ns="export SIM_NAMESERVERS='${SIM_NAMESERVERS:-1.1.1.1}'; "
  denv "${seed_ns}export HUB_DATABASE_URL='${HUB_DSN}'; bash apps/local-sim/scripts/tasks/sql-seed-run.sh" || return 1

  REG_TOKEN=""
  if [ "${MODE}" = "provision" ]; then
    step "mint zone registration token (keyed hub → bridge self-enrolls at startup)"
    token_file="${REPO}/sim-zone-crypto.token"
    mint_err="${REPO}/sim-mint.err"
    # Keyed by zone UUID (not name). mint prints only the token to stdout, but pnpm
    # --silent still echoes a '>' preamble — strip it and keep the last line; stderr
    # goes to a file so a silent mint failure stays diagnosable.
    # SC2016: $tok expands inside the devenv bash. shellcheck disable=SC2016
    denv "export LOCAL_SIMULATION_ENABLED=true HH_ENV=dev DATABASE_URL='${HUB_DSN}'
      tok=\$(pnpm --silent --filter api mint:sim-token -- --zone-id '${ZONE}' --reuse-file '${token_file}' 2>'${mint_err}' | grep -vE '^>|^[[:space:]]*\$' | tail -n1 || true)
      printf '%s' \"\$tok\" > '${token_file}'" ||
      {
        [ -s "${mint_err}" ] && {
          err "mint:sim-token stderr:"
          cat "${mint_err}"
        }
        err "mint invocation failed"
        return 1
      }
    REG_TOKEN="$(cat "${token_file}" 2>/dev/null || true)"
    if [ -z "${REG_TOKEN}" ]; then
      err "mint produced no registration token; mint:sim-token stderr follows:"
      [ -s "${mint_err}" ] && cat "${mint_err}"
      return 1
    fi
    ok "minted registration token (${#REG_TOKEN} chars)"
  fi

  if [ "${MODE}" = "provision" ]; then
    # The bridge bind-mounts these to bake the pubkey into brokkr-live's authorized_keys; a
    # missing path makes Docker create an empty dir at the mount point, so the initrd SSH bake
    # silently no-ops and provision fails late with opaque SSH/agent timeouts. Fail fast here.
    for f in "${SIM_SSH_KEY}" "${SIM_SSH_KEY}.pub"; do
      [ -f "${f}" ] || {
        err "SIM_SSH_KEY material missing: ${f} (set SIM_SSH_KEY to a real keypair)"
        return 1
      }
    done
  fi

  # Pre-create this slot's data bridge: the container self-enrolls by dialing the hub
  # at DATA_GW, and on a cold slot the ~1min fleet-init gap pushes its enroll retry
  # backoff past the BMC seal's poll window. fleet-up's bridge-ensure adopts it.
  if [ "$(uname -s)" = "Linux" ]; then
    sudo ip link add "${DATA_BRIDGE}" type bridge 2>/dev/null || true
    sudo ip addr add "${DATA_GW}/24" dev "${DATA_BRIDGE}" 2>/dev/null || true
    sudo ip link set "${DATA_BRIDGE}" up || return 1
  fi

  step "bridge up (network_mode: host so it advertises a VM-reachable gRPC addr)"
  cat >"${BRIDGE_DIR}/.env" <<EOF
COMPOSE_PROJECT_NAME=sim${SLOT}-bridge
BROKKR_BRIDGE_IMAGE=brokkr-bridge:${TAG}
BRIDGE_PORT=${BRIDGE_PORT}
REDIS_URL=redis://127.0.0.1:${REDIS_HOST_PORT}
BROKKR_ZONE_ID=${ZONE}
BRIDGE_SYNC_ENABLED=false
BRIDGE_AT_REST_KEY=${AT_REST}
BRIDGE_URL=http://${DATA_GW}:${BRIDGE_PORT}
EOF
  {
    echo "services:"
    echo "  brokkr-bridge:"
    echo "    network_mode: host"
    echo "    environment:"
    # Bind AND advertised gRPC ports move together per slot: nothing proxies here, so
    # what the agent dials (GRPC_EXTERNAL_PORT, default 443) must equal the bind port.
    echo "      GRPC_INTERNAL_PORT: '${GRPC_PORT}'"
    echo "      GRPC_EXTERNAL_PORT: '${GRPC_PORT}'"
    # The sim boots via iPXE direct-load + HTTP chain, never TFTP — and the TFTP server
    # binds a fixed 0.0.0.0:69, which collides across slots (the bridge exits on it).
    echo "      TFTP_ENABLED: 'false'"
    if [ "${MODE}" = "provision" ]; then
      echo "      OS_LAYER_URL: '${OS_LAYER_URL}'"
      # Bridge DNS stays off by default (hub-atom controlled; no zone enables it here): the VM
      # reaches the bridge by IP and resolves the OS-layer CDN via the public resolver seeded
      # into its netplan (see SIM_NAMESERVERS above), so the bridge needn't serve brokkr.lan.
      # No nginx fronts the bridge here, so the agent can't use the default TLS
      # gRPC (nginx-terminated on :443). GRPC_INSECURE makes the agent dial plaintext
      # http://, and BRIDGE_HOSTNAME pins the host to the data-plane gateway IP (no
      # DNS); the port it dials is GRPC_EXTERNAL_PORT (set above for every mode).
      echo "      GRPC_INSECURE: 'true'"
      echo "      BRIDGE_HOSTNAME: '${DATA_GW}'"
      # The bridge bakes this key's pubkey into brokkr-live's authorized_keys (and uses
      # it to SSH into devices); the ts-e2e readiness probe SSHes with the same key.
      echo "      BRIDGE_SSH_PRIVKEY_PATH: '/brokkr-ssh/id_ed25519'"
      # zone-crypto S1: BROKKR_HUB_URL is the enrollment master switch + /enroll base
      # (the bridge appends /api/v1/zones/<id>/enroll); the minted token lets it enroll
      # as leader. zone-crypto.config.ts reads both straight from env (no token-file dance).
      echo "      BROKKR_HUB_URL: 'http://${DATA_GW}:${HUB_HOST_PORT}'"
      echo "      BROKKR_REGISTRATION_TOKEN: '${REG_TOKEN}'"
      if [ -n "${SIM_DISCOVERY_CACHE:-}" ]; then
        # Pre-staged discovery set on the runner: bind-mount it and skip the multi-GB
        # blocking sync (which otherwise leaves the bridge unavailable while fleet-init
        # builds the per-VM initrd). See SIM_DISCOVERY_CACHE.
        echo "      BRIDGE_SYNC_ENABLED: 'false'"
      else
        # No cache: sync the discovery set from the asset host on first boot.
        echo "      BRIDGE_SYNC_ENABLED: 'true'"
        echo "      BROKKR_LIVE_VERSION: '${LIVE_VERSION}'"
        echo "      DISCOVERY_BASE_URL: '${DISCOVERY_BASE_URL}'"
      fi
      echo "    volumes:"
      echo "      - '${SIM_SSH_KEY}:/brokkr-ssh/id_ed25519:ro'"
      echo "      - '${SIM_SSH_KEY}.pub:/brokkr-ssh/id_ed25519.pub:ro'"
      [ -n "${SIM_DISCOVERY_CACHE:-}" ] && echo "      - '${SIM_DISCOVERY_CACHE}:/brokkr/brokkr-live'"
    fi
  } >"${BRIDGE_DIR}/docker-compose.override.yml"
  # Provision mode syncs the multi-GB discovery image set on first boot, which
  # gates the health endpoint far longer than the offline smoke bring-up.
  # Smoke default matches the hub (40*5s=200s) so it clears the container's 120s health
  # start_period + retry window; provision syncs the multi-GB discovery set on first boot,
  # which gates the health endpoint far longer.
  bridge_tries=40
  [ "${MODE}" = "provision" ] && bridge_tries=240
  (cd "${BRIDGE_DIR}" && docker compose up -d) || {
    err "bridge compose up failed"
    return 1
  }
  wait_healthy "${BRIDGE_DIR}" brokkr-bridge "${bridge_tries}" || return 1

  step "fleet init"
  denv "set -o pipefail; export HUB_DATABASE_URL='${HUB_DSN}'; python -m local.fleet init" || return 1

  step "fleet up (supervised, background)"
  # Record the supervisor PID: stop_stack must TERM exactly this process — a name-based
  # pkill would match every slot's supervisor on the host.
  denv "export HUB_DATABASE_URL='${HUB_DSN}'; setsid bash -c 'nohup python -m local.fleet up --supervise >${FLEET_LOG} 2>&1 & echo \$! >\"${FLEET_PID}\"'" || return 1

  log "wait for fleet readiness"
  # SC2016: single-quoted on purpose — this runs inside the devenv bash, not here.
  # shellcheck disable=SC2016
  denv 'for _ in $(seq 1 36); do python -m local.status --ready >/dev/null 2>&1 && exit 0; sleep 5; done; exit 1' ||
    warn "fleet readiness flag not set; smoke will confirm"

  step "ts-e2e smoke"
  # Smoke does not bake a device key into the VM (BRIDGE_SSH_PRIVKEY_PATH is provision-only), so
  # its VMClient probe uses ssh's default identity as before -- don't export SIM_SSH_KEY here (only
  # provision needs it, where the bridge bakes that key's pubkey and the probe must dial -i it).
  denv "export HUB_DATABASE_URL='${HUB_DSN}'
    cd apps/local-sim/tests/ts-e2e
    '${REPO}/node_modules/.bin/vitest' run --config ./vitest.config.ts --root . \
      --reporter=default --reporter=junit --outputFile.junit='${REPO}/sim-junit-smoke-s${SLOT}.xml' test-smoke.test.ts" || return 1
  ok "ts-e2e smoke passed"

  if [ "${MODE}" = "provision" ]; then
    step "seal BMC creds (zone-crypto S1) so provision's precondition finds a usable credential"
    # Seals admin/admin per sim Server to the zone pubkey (needs BROKKR_HUB_PRIVATE_KEY,
    # else "hub crypto dormant" seals nothing); without a sealed cred the provision PATCH
    # 400s. seed:sim-bmc exits 0 even when it seals nothing, so assert sealed>=1 from its
    # "done: N sealed" summary instead of trusting the exit code.
    bmc_out="$(denv "export LOCAL_SIMULATION_ENABLED=true HH_ENV=dev DATABASE_URL='${HUB_DSN}' BROKKR_HUB_PRIVATE_KEY='${HUB_PRIVATE_KEY}'; pnpm --filter api seed:sim-bmc" 2>&1)" ||
      {
        printf '%s\n' "${bmc_out}"
        err "seed:sim-bmc failed"
        return 1
      }
    printf '%s\n' "${bmc_out}"
    bmc_sealed="$(printf '%s\n' "${bmc_out}" | sed -n 's/.*done: \([0-9][0-9]*\) sealed.*/\1/p' | tail -1)"
    if [ "${bmc_sealed:-0}" -lt 1 ]; then
      err "seed:sim-bmc sealed no BMC creds (zone not enrolled?) — provision would 400; failing early"
      return 1
    fi
    ok "sealed ${bmc_sealed} BMC cred(s) to the zone pubkey"

    step "ts-e2e provision E2E (lifecycle-quick: provision -> PROVISIONED via phone-home -> deprovision)"
    denv "export HUB_DATABASE_URL='${HUB_DSN}' \
      BRIDGE_ZONE_ID='${ZONE}' SIM_PLAN='lifecycle-quick' SIM_SSH_KEY='${SIM_SSH_KEY}'
      cd apps/local-sim/tests/ts-e2e
      '${REPO}/node_modules/.bin/vitest' run --config ./vitest.config.ts --root . \
      --reporter=default --reporter=junit --outputFile.junit='${REPO}/sim-junit-plan-s${SLOT}.xml' plan.test.ts" || return 1
    ok "provision E2E passed (device reached PROVISIONED, then deprovisioned)"
  fi

  ok "sim-e2e ${MODE} run complete"
}

main "$@"
