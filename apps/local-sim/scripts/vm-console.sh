#!/bin/bash
# Resilient SOL console for one sim VM via the BMC (ipmitool sol activate). The
# serial is a telnet socket owned by ipmi_sim, so interactive access goes through
# the BMC, not `virsh console`. node:console / fleet:consoles tail the <log>
# independently. Usage: vm-console.sh <domain> <libvirt-uri>
set -u

NAME="${1:?usage: vm-console.sh <domain> <libvirt-uri>}"
URI="${2:?usage: vm-console.sh <domain> <libvirt-uri>}"

read -r BMC USER_ PASS < <(python -c "
import yaml
from local.config import get_settings
from local.derived import effective_bmc_ip
from local.schema import Fleet
f = Fleet.model_validate(yaml.safe_load(get_settings().paths.fleet_path.read_text()))
i, n = next((i, n) for i, n in enumerate(f.nodes) if n.name == '$NAME')
print(effective_bmc_ip(n, f.network.bmc_cidr, i), n.bmc.username, n.bmc.password)
" 2>/dev/null)

if [ -z "${BMC:-}" ]; then
  echo "── could not resolve BMC for '$NAME' (not in fleet.yml?) ──" >&2
  exit 1
fi
IPMI=(ipmitool -I lanplus -C 3 -H "$BMC" -p 623 -U "$USER_" -P "$PASS")

while true; do
  if virsh --connect "$URI" domstate "$NAME" 2>/dev/null | grep -q running; then
    echo "── $NAME running — SOL console via BMC $BMC (~. detaches; it reattaches) ──"
    "${IPMI[@]}" sol deactivate >/dev/null 2>&1 || true
    "${IPMI[@]}" sol activate || true
    echo ""
    echo "── $NAME SOL closed (powered off / rebooting / detached) — waiting … ──"
  else
    printf "\r── waiting for %s to power on … %s ──" "$NAME" "$(date +%H:%M:%S)"
  fi
  sleep 2
done
