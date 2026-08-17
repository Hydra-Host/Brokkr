#!/bin/bash
# Configure per-leaf ECMP routes for RoCE east-west fabric.
# Rail A (10.12.x/10.13.x -> SW-2659): /15 route via all /31 interfaces in that range
# Rail B (10.14.x/10.15.x -> SW-2661): /15 route via all /31 interfaces in that range
# Deployed via cloud-init write_files, executed by hydra-roce-ecmp.service.

set -uo pipefail

rail_a=""
rail_b=""

while IFS= read -r line; do
  iface=$(echo "$line" | awk '{print $1}')
  addr=$(echo "$line" | awk '{print $2}' | cut -d/ -f1)

  IFS='.' read -r a b c d <<<"$addr"

  # Calculate peer IP (+1 if even, -1 if odd)
  if ((d % 2 == 0)); then
    peer="$a.$b.$c.$((d + 1))"
  else
    peer="$a.$b.$c.$((d - 1))"
  fi

  # Sort by second octet: 12-13 = rail A, 14-15 = rail B
  if ((b <= 13)); then
    rail_a="$rail_a nexthop via $peer dev $iface weight 1"
  else
    rail_b="$rail_b nexthop via $peer dev $iface weight 1"
  fi
done < <(ip -4 -o addr show | awk '/\/31/ {print $2, $4}')

# Add ECMP route for each rail (word splitting is intentional — each
# $rail_* expands to multiple "nexthop via <ip> dev <iface> weight 1" args)
if [ -n "$rail_a" ]; then
  # shellcheck disable=SC2086
  ip route add 10.12.0.0/15 $rail_a 2>/dev/null || true
fi

if [ -n "$rail_b" ]; then
  # shellcheck disable=SC2086
  ip route add 10.14.0.0/15 $rail_b 2>/dev/null || true
fi
