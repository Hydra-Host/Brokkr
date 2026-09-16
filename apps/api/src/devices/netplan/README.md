# Netplan renderer

`renderNetplanYaml` (`netplan-consolidated.ts`) is the single entry point. It derives a device's
**render family** from role + zone and dispatches to the matching module in `render/`.

Resolution chain: operator `netplanOverride` (full YAML, applied by `NetplanService` before the
dispatcher is reached) → `Device.netplanPopulation` (an explicit family pin) → `derivePopulation()`.

The six families differ in load-bearing ways — route metrics, DNS fallbacks, bond MAC selection, VRF
resolution. Unifying them is a production routing change, not a refactor.

| Family                                               | Source                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `flat`                                               | `render/flat.ts` — the default; everything not bridge-role or VPC-zone |
| `vpc`, `vpc-roce`                                    | `render/vpc.ts` + `vpc-planner.ts` + `vpc-lifecycle.ts`                |
| `bridge-default`, `bridge-bonded`, `bridge-sans-vrf` | `render/bridge-*.ts`                                                   |

## Invariants

These look like cleanup opportunities and are not. Each was added deliberately:

1. **`render/flat.ts` falls back to DHCP when no default route resolves.** A device with addresses
   but no resolvable gateway would otherwise emit a static config that reaches nothing off-subnet.
   This is not theoretical — it fires whenever a primary prefix is missing its `Gateway` row.
2. **Bond parameters are Zod-validated, `pickGateway` is priority-ordered, and a bond needs ≥2
   members.** Dropping any of the three silently degrades routing rather than failing.
3. **There is no `ipam.vrfGateways`.** The VPC renderers reach gateways through
   `vrfPrefixes[].gateways`; a parallel gateway set is a second query for data already loaded.

## Gotchas

- **A gateway must share its prefix's VRF.** The planner resolves a device's route VRF as
  `ip.vrfId ?? prefix.vrfId` and matches `gateway.vrfId` against it, so a NULL-VRF gateway on a
  VRF-attached prefix never matches and the device renders with no default route.
- **`prefixContainsIpv4(cidr, host)` takes its arguments in the mirror order of the shared
  `ipInCidr(ip, cidr)` it wraps.** Both spellings exist so a mis-transcribed call site fails to
  compile instead of silently resolving every prefix to nothing.
- **`NetplanPhase` is declared on `netplan.service.ts`** and re-exported by the dispatcher.
  `common/redis/redis-keys.ts` keeps its own copy on purpose — it is a lower layer and must not
  import from `devices/`. Keep the two in step.
- **The VPC families resolve only against `ipam.vrfPrefixes`.** A VPC-zone device whose IPs carry no
  VRF resolves nothing and falls back to DHCP; that is correct, not a bug.
