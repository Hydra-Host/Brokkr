#!/usr/bin/env bash
# task ipmi -- <node> <ipmi command> — ipmitool passthrough.
# Args ($@) are the task's CLI_ARGS: first the node name, then the ipmi command.
NODE="$1"
shift
read -r BMC_IP BMC_USER BMC_PASS < <(python -c "
import yaml
from local.config import get_settings
from local.derived import bmc_ip
# Active config is what the engine resolves (LOCAL_FLEET_PATH → Nix-rendered fleet.yml,
# else _default_fleet_path) — must match the node fleet:up started ipmi_sim for.
f = yaml.safe_load(open(get_settings().paths.fleet_path))
defaults_bmc = (f.get('defaults') or {}).get('bmc') or {}
for i, n in enumerate(f['nodes']):
    if n['name'] == '$NODE':
        bmc = n.get('bmc') or defaults_bmc
        # honor a per-node bmc_ip override (matches derived.effective_bmc_ip)
        print(n.get('bmc_ip') or bmc_ip(f['network']['bmc_cidr'], i),
              bmc.get('username', 'admin'), bmc.get('password', 'admin'))
        break
")
if [ -z "$BMC_IP" ]; then
  echo "node not found in active fleet config: $NODE" >&2
  exit 1
fi
ipmitool -I lanplus -H "$BMC_IP" -p 623 -U "$BMC_USER" -P "$BMC_PASS" "$@"
