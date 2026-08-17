#!/usr/bin/env bash
# task redfish -- <node> <verb> — Redfish curl passthrough.
# verb: power-on | power-off | power-cycle | status. Args ($@) are CLI_ARGS.
NODE="$1"
VERB="$2"
read -r BMC_IP UUID BMC_USER BMC_PASS PORT < <(python -c "
import yaml
from local.config import get_settings
from local.derived import bmc_ip, node_uuid
s = get_settings()
# Active config is custom-first (fleet.local.yml > fleet.yml) — must match what
# fleet:up started ipmi_sim/sushy for, else the node/UUID/BMC-IP won't line up.
f = yaml.safe_load(open(s.paths.fleet_path))
defaults_bmc = (f.get('defaults') or {}).get('bmc') or {}
for i, n in enumerate(f['nodes']):
    if n['name'] == '$NODE':
        bmc = n.get('bmc') or defaults_bmc
        # honor a per-node bmc_ip override (matches derived.effective_bmc_ip)
        print(n.get('bmc_ip') or bmc_ip(f['network']['bmc_cidr'], i), node_uuid(n['ipmi_mac']),
              bmc.get('username', 'admin'), bmc.get('password', 'admin'),
              s.sim.redfish_port)
        break
")
if [ -z "$BMC_IP" ]; then
  echo "node not found in active fleet config: $NODE" >&2
  exit 1
fi
AUTH="$BMC_USER:$BMC_PASS"
URL="http://$BMC_IP:$PORT/redfish/v1/Systems/$UUID"
# -f / --fail-with-body: curl exits non-zero on HTTP 4xx/5xx so callers (notably
# reset_device.py's _power_cycle gate) can detect a Redfish error response that
# would otherwise look like a successful POST returning a JSON error body.
case "$VERB" in
status) curl -fsS -u "$AUTH" "$URL" | jq '.PowerState' ;;
power-on) curl -fsS -u "$AUTH" -X POST -H 'Content-Type: application/json' -d '{"ResetType":"On"}' "$URL/Actions/ComputerSystem.Reset" ;;
power-off) curl -fsS -u "$AUTH" -X POST -H 'Content-Type: application/json' -d '{"ResetType":"ForceOff"}' "$URL/Actions/ComputerSystem.Reset" ;;
power-cycle) curl -fsS -u "$AUTH" -X POST -H 'Content-Type: application/json' -d '{"ResetType":"ForceRestart"}' "$URL/Actions/ComputerSystem.Reset" ;;
*)
  echo "unknown verb: $VERB (valid: status, power-on, power-off, power-cycle)" >&2
  exit 1
  ;;
esac
