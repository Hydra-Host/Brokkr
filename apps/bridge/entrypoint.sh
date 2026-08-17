#!/bin/bash
set -e

# Structured-log helper: matches the bridge's runtime JSON shape so the log
# aggregator sees entrypoint lines as the same shape as every other line the
# bridge produces. tini reaps Node + subprocess children and forwards
# SIGTERM/SIGINT to the Node process; this script stages the boot-time
# artifact bundles into the persistent-storage volume the bridge serves from.
log() {
  local message="$1"
  # Honor LOG_FORMAT like the app logger (logger.service.ts): default JSON for
  # aggregation; `console` emits the same no-color BridgeConsoleFormatter shape
  # ([app] <ts>  <LEVEL(7)> [class] msg) so entrypoint lines align with the app's.
  if [ "$(printf '%s' "${LOG_FORMAT:-json}" | tr '[:upper:]' '[:lower:]')" = "console" ]; then
    # `   INFO` = INFO padded to LEVEL_WIDTH=7, with the formatter's 2-space gap → 5 spaces.
    printf '[bridge-api] %s     INFO [entrypoint] %s\n' "$(date +"%m/%d/%Y, %I:%M:%S %p")" "$message"
  else
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%S.%6N+00:00")
    echo "{\"app_name\": \"bridge-api\", \"app_class_name\": \"entrypoint\", \"job_id\": \"\", \"log_level\": \"info\", \"message\": \"$message\", \"timestamp\": \"$timestamp\"}"
  fi
}

case "$1" in
"start")

  rm -f /tmp/brokkr_startup* /brokkr/startup-coordination/brokkr_startup* 2>/dev/null || true
  log "Cleared startup completion markers"

  # Destination MUST match the bridge's PERSISTENT_STORAGE_PATH resolution
  # — the initrd HTTP routes serve from $PERSISTENT_STORAGE_PATH/initrd-builds/.
  persistent_base="${PERSISTENT_STORAGE_PATH:-/brokkr}"
  mkdir -p "$persistent_base/initrd-builds"
  cp -f /opt/brokkr/initrd-builds/brokkr-live.img "$persistent_base/initrd-builds/brokkr-live.img"
  log "Staged baked brokkr-live.img into $persistent_base/initrd-builds"
  cp -f /opt/brokkr/initrd-builds/bridge-agent.img "$persistent_base/initrd-builds/bridge-agent.img"
  log "Staged baked bridge-agent.img into $persistent_base/initrd-builds"

  # /ipxe-share is the volume shared with the Samba sidecar; absent in
  # testbed/local-dev where there's no sidecar.
  if [ -d /ipxe-share ]; then
    mkdir -p /ipxe-share/final
    if [ -f /opt/brokkr/ipxe-builds/ipxe.iso ]; then
      cp -f /opt/brokkr/ipxe-builds/ipxe.iso /ipxe-share/final/ipxe.iso
      log "Staged ipxe.iso into /ipxe-share/final for CIFS sharing"
    else
      log "No ipxe.iso baked into image; CIFS share will be empty"
    fi
  fi

  # Keep the loopback default (listen-target.ts) so the image
  # fails safe: the unauthenticated bare-metal control REST surface is not
  # bound to all interfaces unless an operator explicitly opts in via HOST
  # (e.g. HOST=0.0.0.0 behind the firewalled management network, set by the
  # deploy contract). For off-box reach prefer a host-side loopback port
  # map (-p 127.0.0.1:8080:8080). gRPC (GRPC_INTERNAL_HOST) is separate.

  log "Starting application via orchestrator"

  exec node /app/dist/main.js
  ;;

*)
  log "Unknown command: $1"
  exit 1
  ;;
esac
