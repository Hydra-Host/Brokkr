# Brokkr Deployment

How to run a self-hosted Brokkr - the OSS runtime an operator installs to manage
their own bare metal. This directory holds the **deployment deliverables**: one
folder per target, all running the same component set against the same
configuration contract.

## Component model

What a self-hoster runs. The hard requirements are **Postgres + Redis only** -
everything else is internal to the app or a stubbed/optional integration.

| Component                | Image                 | Role                                                   |
| ------------------------ | --------------------- | ------------------------------------------------------ |
| `postgres`               | `postgres:16`         | Hub database (source of truth).                        |
| `redis`                  | `redis:7`             | Cache **and** the hub<->bridge message bus (BullMQ).   |
| `migrate`                | `BROKKR_APP_IMAGE`    | One-shot `prisma migrate deploy`, runs before the hub. |
| `hub` (brokkr-hub)       | `BROKKR_APP_IMAGE`    | Operator + customer app and API (`:3000`).             |
| `bridge` (brokkr-bridge) | `BROKKR_BRIDGE_IMAGE` | The "spoke" - drives the local bare metal (`:8000`).   |

The hub is the control plane; bridges run out at each site and reach the hub
**only** over the shared Redis bus (keyed by a Zone UUID), so a bridge can live
on a separate machine/network.

## Targets

| Target            | Folder                                 | Status                                                                                          |
| ----------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Docker Compose    | [`docker-compose/`](./docker-compose/) | **Available** - initial release; ships as two units (`hub/` + `bridge/`) for separate machines. |
| Nomad             | [`nomad/`](./nomad/)                   | **Available** - two jobs (`hub/` + `bridge/`) driven by Nomad Variables, mirroring the units.   |
| Kubernetes (Helm) | [`helm/`](./helm/)                     | **Available** - two charts (`brokkr-hub/` + `brokkr-bridge/`) mirroring the Compose units.      |

Every target deploys the component model above and is driven by the same
configuration contract, so an operator who knows one can read the next.

## Configuration contract

The knobs an operator sets. These are the same keys across every target (Compose
`.env`, Helm values, future Nomad variables); only the delivery mechanism
differs. The authoritative, fully-commented surface is the per-unit env template:
[`docker-compose/hub/.env.example`](./docker-compose/hub/.env.example) and
[`docker-compose/bridge/.env.example`](./docker-compose/bridge/.env.example).

| Group              | Keys                                                                            | Notes                                                                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Images**         | `BROKKR_APP_IMAGE`, `BROKKR_BRIDGE_IMAGE`                                       | Public on Docker Hub: `hydrahost/brokkr-hub` / `hydrahost/brokkr-bridge`, multi-arch (amd64+arm64), built from the public source tree and published on each tagged release. The published bridge ships no CA: to trust your own root, create `apps/bridge/ca/`, put the PEM in it and rebuild. |
| **Identity**       | `BROKKR_ZONE_ID`, `HYDRAHOST_ORGANIZATION_ID`                                   | `BROKKR_ZONE_ID` is the bridge's Redis namespace (`REDIS_PREFIX`).                                                                                                                                                                                                                             |
| **Datastores**     | `DATABASE_URL`, `REDIS_URL`                                                     | The two hard dependencies.                                                                                                                                                                                                                                                                     |
| **Auth**           | `BETTER_AUTH_SECRET`                                                            | Session signing secret.                                                                                                                                                                                                                                                                        |
| **Mode / toggles** | `LOCAL_SIMULATION_ENABLED`, `GRPC_INSECURE`, `BRIDGE_SYNC_ENABLED`, `LOG_LEVEL` | Operator-facing behavior switches. Set `GRPC_INSECURE=true` to run agent↔bridge gRPC over plaintext (no TLS/cert) when TLS is terminated elsewhere or absent — independent of `LOCAL_SIMULATION_ENABLED`.                                                                                     |
| **Integrations**   | `CLICKHOUSE_*`, `VAULT_*`, `NETBOX_*`, ...                                      | Present-but-stubbed today; moving into the plugin system. Leave empty in sim mode.                                                                                                                                                                                                             |

**Asset origin (discovery OS + OS layers).** A bridge with `BRIDGE_SYNC_ENABLED=true` downloads
the discovery OS from `${DISCOVERY_BASE_URL}/${BROKKR_LIVE_VERSION}/<arch>`, and the hub seeds its
OS catalog on start from `OS_LAYER_MANIFEST_URL` (defaults to the public release index, followed to
the current version; set it empty to skip the seed). Those discovery images — `vmlinuz`,
`initrd.img`, `brokkr-discovery.iso` — are **published binaries; this repo contains no builder for
them**. Only the cpio overlays layered on top (`brokkr-live.img`, `bridge-agent.img`) are built
here. To run entirely on your own artifacts, publish the same `<version>/<arch>/` layout on an
origin you control and point these knobs at it.

## Principles

- **Postgres + Redis are the only hard dependencies.** Anything else is internal
  or an optional integration, expressed as a config knob - never a silent
  requirement.
- **App behavior is the developers' domain; packaging is this folder's.** When an
  integration (Vault, NetBox, the asset CDN) becomes optional/pluginized
  upstream, the deliverable just flips a knob - no repackaging.
- **One contract, many targets.** New targets conform to the component model and
  the configuration contract above rather than inventing their own surface.

See each target's own `README.md` for run instructions.
