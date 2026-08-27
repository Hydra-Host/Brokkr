# syntax=docker/dockerfile:1

ARG VERSION=0.0.0-dev

# The firmware chain (ipxe-src → ipxe-amd64/ipxe-arm64 → ipxe-iso) is pinned to amd64 hosts:
# the CROSS= flags below fix each artifact's target arch regardless of host, and a constant
# host platform keeps these stages' cache keys identical across the amd64 and arm64 legs of a
# multi-arch build — the arm64 leg imports them from registry cache instead of rebuilding.
# hadolint ignore=DL3029
FROM --platform=linux/amd64 ubuntu:24.04 AS ipxe-src
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      git \
      gnu-efi \
      liblzma-dev \
      make \
      perl \
      xz-utils

ARG IPXE_COMMIT=5921e6b45
# Cache a bare mirror so a cache-cold rebuild clones locally instead of re-fetching over the
# network. Fetch only when the pinned commit isn't already in the mirror, so bumping IPXE_COMMIT
# to a newer SHA still resolves (a cached mirror is otherwise never refreshed), while an unchanged
# commit stays offline/fast.
RUN --mount=type=cache,id=ipxe-git,target=/git-cache,sharing=locked \
    set -eux; \
    [ -d /git-cache/ipxe.git ] || git clone --bare https://github.com/ipxe/ipxe.git /git-cache/ipxe.git; \
    git -C /git-cache/ipxe.git cat-file -e "${IPXE_COMMIT}^{commit}" 2>/dev/null \
      || git -C /git-cache/ipxe.git fetch --quiet origin "+refs/heads/*:refs/heads/*"; \
    git clone /git-cache/ipxe.git /opt/ipxe; \
    cd /opt/ipxe && git checkout ${IPXE_COMMIT}

COPY apps/bridge/boot/ipxe/overlay/                /opt/ipxe/src/
COPY apps/bridge/boot/ipxe/config/general.h        /opt/ipxe/src/config/general.h
COPY apps/bridge/boot/ipxe/config/branding.h       /opt/ipxe/src/config/branding.h
COPY apps/bridge/boot/ipxe/autoexec-chainload.ipxe /opt/ipxe/src/autoexec.ipxe

COPY apps/bridge/ca/ /build/ca/

# Chain base URL baked into the embedded autoexec. Default is the nginx :443 front door (the bridge API
# binds loopback-only, so :443 is the only externally reachable path); the local sim overrides it with a
# plaintext http://<gw>:<port> endpoint (apps/local-sim/scripts/local/ipxe_build.py passes --build-arg).
ARG CHAIN_BASE_URL=https://brokkr.lan
# TRUST bakes the CAs that signed the :443 cert so iPXE can validate the HTTPS chain: a COMMA-separated
# list of individual CA .pem paths (not a concatenated bundle) — iPXE's make splits TRUST on commas.
# Merged with the certs in /build/ca (apps/bridge/ca/) by the build stages below.
ARG TRUST=
# grep asserts the sed rewrote the placeholder (sed exits 0 on no-match), so a renamed placeholder can't
# silently ship a binary still pointing at the wrong host.
RUN sed -i "s|https://brokkr.lan/api/chain|${CHAIN_BASE_URL}/api/chain|g" /opt/ipxe/src/autoexec.ipxe && \
    grep -qF "${CHAIN_BASE_URL}/api/chain" /opt/ipxe/src/autoexec.ipxe

# hadolint ignore=DL3029
FROM --platform=linux/amd64 ipxe-src AS ipxe-amd64
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      gcc-x86-64-linux-gnu
WORKDIR /opt/ipxe/src
# No object-cache mount here: iPXE's make is mtime-driven, and persisting bin-*-efi across builds
# risks skipping a relink when an ipxe-src input (overlay, embedded autoexec) changes,
# baking stale firmware. The git-mirror cache above already removes the dominant (network) cost.
RUN set -eux && \
    CA_TRUST="$(find /build/ca -maxdepth 1 \( -name '*.crt' -o -name '*.pem' \) | sort | paste -sd, -)" && \
    make -j"$(nproc)" \
      bin-x86_64-efi/ipxe.efi \
      bin-x86_64-efi/snp.efi \
      bin-x86_64-efi/snponly.efi \
      CROSS=x86_64-linux-gnu- \
      TRUST="${CA_TRUST}${CA_TRUST:+${TRUST:+,}}${TRUST}" \
      EMBED=autoexec.ipxe && \
    mkdir -p /export/amd64 && \
    cp bin-x86_64-efi/ipxe.efi    /export/amd64/ && \
    cp bin-x86_64-efi/snp.efi     /export/amd64/ && \
    cp bin-x86_64-efi/snponly.efi /export/amd64/

# hadolint ignore=DL3029
FROM --platform=linux/amd64 ipxe-src AS ipxe-arm64
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      gcc-aarch64-linux-gnu
WORKDIR /opt/ipxe/src
# No object-cache mount here (see the amd64 stage): a persisted bin-*-efi can bake stale firmware.
RUN set -eux && \
    CA_TRUST="$(find /build/ca -maxdepth 1 \( -name '*.crt' -o -name '*.pem' \) | sort | paste -sd, -)" && \
    make -j"$(nproc)" \
      bin-arm64-efi/ipxe.efi \
      bin-arm64-efi/snp.efi \
      bin-arm64-efi/snponly.efi \
      CROSS=aarch64-linux-gnu- \
      TRUST="${CA_TRUST}${CA_TRUST:+${TRUST:+,}}${TRUST}" \
      EMBED=autoexec.ipxe && \
    mkdir -p /export/arm64 && \
    cp bin-arm64-efi/ipxe.efi    /export/arm64/ && \
    cp bin-arm64-efi/snp.efi     /export/arm64/ && \
    cp bin-arm64-efi/snponly.efi /export/arm64/

# isolinux/syslinux-common are amd64-only, so this stage must run as amd64.
# hadolint ignore=DL3029
FROM --platform=linux/amd64 ipxe-src AS ipxe-iso
# isolinux/syslinux-common required by genfsimg even though we only emit UEFI.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      dosfstools \
      isolinux \
      mtools \
      syslinux-common \
      xorriso
WORKDIR /opt/ipxe/src

# Skip `make util/genfsimg`; it triggers iPXE's eager DEPS scan that emits
# x86-32 gcc errors on hosts without multilib. The script needs no build.
COPY --from=ipxe-amd64 /export/amd64/ipxe.efi /efi-in/amd64.efi
COPY --from=ipxe-arm64 /export/arm64/ipxe.efi /efi-in/arm64.efi
RUN set -eux && \
    mkdir -p /export && \
    chmod +x util/genfsimg && \
    util/genfsimg \
      -o /export/ipxe.iso \
      /efi-in/amd64.efi \
      /efi-in/arm64.efi

# Local-dev only: minimal collector so `local.ipxe_build` (apps/local-sim) exports just the iPXE
# artifacts (~1.6MB) instead of a fat stage rootfs. Unreachable from `release` (nothing COPYs it),
# so CI/prod never build it. Must stay before `release` (last stage = default target).
FROM scratch AS ipxe-export
COPY --from=ipxe-amd64 /export/amd64/ /export/amd64/
COPY --from=ipxe-arm64 /export/arm64/ /export/arm64/
COPY --from=ipxe-iso   /export/ipxe.iso /export/ipxe.iso

# Shared node toolchain for the live-agent and bridge-api builds. VERSION is deliberately
# NOT consumed here: an ARG/ENV read this early re-keys every downstream layer on each
# version bump, defeating the registry build cache. It is injected only where it is used
# (agent-build bakes it via tsup; the release stage reads it at runtime).
FROM node:24-slim@sha256:03eae3ef7e88a9de535496fb488d67e02b9d96a063a8967bae657744ecd513f2 AS node-base
ENV PNPM_HOME="/pnpm"
# pnpm 11 installs global bins into $PNPM_HOME/bin and refuses `add -g` unless that exact
# directory is on PATH; pnpm 8 used $PNPM_HOME itself. Both are listed so either resolves.
ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"
# Pin pnpm to the workspace's packageManager version so image builds don't drift with
# corepack's latest resolution (keep in sync with apps/api/Dockerfile).
RUN corepack enable && corepack install -g pnpm@11.21.0
# pnpm 11 defaults verifyDepsBeforeRun to `install`, so `pnpm exec` / `pnpm run` fire an implicit
# install mid-build that reaches the registry and prunes the layer below it. That layer is the
# authority here; a build must never re-resolve dependencies.
ENV pnpm_config_verify_deps_before_run=false
# node-gyp toolchain for native workspace deps (no linux prebuilts); python 3.12 dropped
# distutils, so setuptools provides the shim. Build stages only — release is a separate slim image.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-setuptools \
      make \
      g++
WORKDIR /src

# Manifest-only staging: the install layer re-keys only when the lockfile/package.jsons
# change, so source edits reuse the node-gyp-compiled node_modules. NOT `turbo prune`:
# every turbo release (2.5-2.10) drops the peer-cyclic vitest<->@vitest/coverage-v8
# snapshots (apps/bridge devDeps) from its pruned lockfile while keeping references,
# failing the frozen install — so we install the full workspace from the root lockfile.
FROM node-base AS manifests
COPY . /all
RUN mkdir /out && cd /all && \
    cp --parents pnpm-lock.yaml pnpm-workspace.yaml package.json /out/ && \
    find apps packages -maxdepth 3 -name package.json -not -path '*/node_modules/*' \
      -exec cp --parents {} /out/ \;

FROM node-base AS pnpm-base
COPY --from=manifests /out/ ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm exec buf generate && \
    pnpm --filter @repo/bridge-agent-protocol build && \
    pnpm --filter @repo/api-client build

FROM pnpm-base AS agent-build
# tsup bakes AGENT_VERSION into the agent bundle (see apps/live-agent/tsup.config.ts's
# version model), so VERSION must be consumed here — and only here among the build
# stages — right before the build, re-keying just this stage on a version bump.
ARG VERSION
ENV AGENT_VERSION=${VERSION}
# turbo (not bare `pnpm --filter`) so bridge-agent's workspace deps build first — tsup
# bundles @repo/api-client (via @repo/utils), which must have its dist/ before bundling.
RUN pnpm exec turbo run build --filter=bridge-agent && \
    test -f apps/live-agent/dist/main.js

FROM pnpm-base AS bridge-build
RUN pnpm exec turbo run build --filter=bridge && \
    test -f apps/bridge/dist/main.js

# `pnpm deploy --prod` writes the self-contained runtime tree to /bridge-deploy; dist/
# and assets/ are grafted next to it for a one-shot COPY in the release stage.
RUN pnpm --config.trustLockfile=true --filter bridge deploy --prod /bridge-deploy && \
    test -d /bridge-deploy/node_modules/reflect-metadata && \
    cp -R apps/bridge/dist   /bridge-deploy/dist && \
    cp -R apps/bridge/assets /bridge-deploy/assets

# AF_PACKET raw-Ethernet N-API addon (DHCP L2 unicast/broadcast send+recv). Pure-C, uses only
# <node_api.h> from Node's headers (node-gyp fetches them) — no node-addon-api, so the build needs
# just python3 + setuptools (node-gyp's distutils shim on Python 3.12, same as node-base) + make/g++.
# Digest-pinned to the SAME image as node-base/release so the .node is compiled against the exact
# Node runtime the release stage loads it on (no cross-stage ABI drift). No `--platform`, so buildx
# still compiles it natively per target arch. If it's ever absent the bridge degrades to
# dgram-broadcast (packet-socket.ts's graceful fallback), so wiring it in only ever adds the L2 fast path.
FROM node:24-slim@sha256:03eae3ef7e88a9de535496fb488d67e02b9d96a063a8967bae657744ecd513f2 AS afpacket-build
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends python3 python3-setuptools make g++
# Pin node-gyp to an exact version in a dedicated layer so it is cached independently
# of source changes, and use an npm cache mount for reproducible installs.
RUN --mount=type=cache,target=/root/.npm npm install -g node-gyp@11.2.0
WORKDIR /afpacket
COPY apps/bridge/native/afpacket/ ./
RUN node-gyp rebuild && test -f build/Release/afpacket.node

FROM ubuntu:24.04 AS initrd-build
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      cpio ca-certificates

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

COPY apps/bridge/boot/initrd-live/ /build/initrd/

COPY apps/bridge/ca/ /build/ca/

RUN set -eux && \
    mkdir -p /build/initrd/etc/ssl/certs \
             /build/initrd/brokkr/usr/local/share/ca-certificates && \
    for cert in /build/ca/*.crt /build/ca/*.pem; do \
      [ -e "$cert" ] || continue; \
      base="$(basename "$cert")"; \
      cp "$cert" "/build/initrd/brokkr/usr/local/share/ca-certificates/${base%.*}.crt"; \
    done && \
    # Pre-merged bundle for do_urlmount_override's --cacert (runs before update-ca-certificates).
    { awk 1 /build/initrd/brokkr/usr/local/share/ca-certificates/*.crt 2>/dev/null || true; } > /build/initrd/etc/ssl/certs/brokkr-ca.crt && \
    cd /build/initrd && find . | sort | cpio --quiet -o -H newc > /build/brokkr-live.img && \
    test -s /build/brokkr-live.img

# hadolint ignore=DL3029
FROM --platform=linux/amd64 ubuntu:24.04 AS grub-build
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    set -eux && \
    sed -i '/^Components:/a Architectures: amd64' /etc/apt/sources.list.d/ubuntu.sources && \
    dpkg --add-architecture arm64 && \
    printf 'Types: deb\nURIs: http://ports.ubuntu.com/ubuntu-ports/\nSuites: noble noble-updates noble-security\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\nArchitectures: arm64\n' \
      > /etc/apt/sources.list.d/ubuntu-ports.sources && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      grub-common \
      grub-efi-amd64-bin \
      grub-efi-arm64-bin:arm64 \
      grub-pc-bin

WORKDIR /build
COPY apps/bridge/boot/grub/grub-efi-amd64.cfg apps/bridge/boot/grub/grub-efi-arm64.cfg apps/bridge/boot/grub/grub-legacy.cfg ./

ARG GRUB_LEGACY_MODULES="boot cat chain configfile echo ext2 fat gzio halt iso9660 linux linux16 normal part_gpt part_msdos reboot search search_fs_file search_fs_uuid search_label test tftp"
# efidisk.mod is rolled into disk.mod; listing it aborts grub-mkstandalone.
ARG GRUB_EFI_MODULES="part_gpt fat ext2 xfs lvm mdraid09 mdraid1x chain search search_fs_file configfile normal echo test sleep"

RUN set -eux && mkdir -p /export && \
    grub-mkstandalone --format=x86_64-efi --modules="${GRUB_EFI_MODULES}" --output=/export/bootx64.efi  "boot/grub/grub.cfg=grub-efi-amd64.cfg" && \
    grub-mkstandalone --format=arm64-efi  --modules="${GRUB_EFI_MODULES}" --output=/export/bootaa64.efi "boot/grub/grub.cfg=grub-efi-arm64.cfg" && \
    grub-mkstandalone --format=i386-pc    --output=/export/core.img \
      --install-modules="${GRUB_LEGACY_MODULES}" \
      --modules="${GRUB_LEGACY_MODULES}" \
      --locales="" \
      --fonts="" \
      --directory="/usr/lib/grub/i386-pc" \
      "boot/grub/grub.cfg=grub-legacy.cfg" && \
    test -s /export/bootx64.efi && test -s /export/bootaa64.efi && test -s /export/core.img

FROM ubuntu:24.04 AS bridge-agent-initrd
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends cpio

RUN mkdir -p /build/initrd/brokkr/opt/brokkr/agent \
             /build/initrd/brokkr/etc/systemd/system

COPY --from=agent-build /src/apps/live-agent/dist/main.js /build/initrd/brokkr/opt/brokkr/agent/main.js
COPY apps/live-agent/systemd/brokkr-bridge-agent.service /build/initrd/brokkr/etc/systemd/system/brokkr-bridge-agent.service

RUN set -eux && \
    cd /build/initrd && find . | sort | cpio --quiet -o -H newc > /build/bridge-agent.img && \
    test -s /build/bridge-agent.img

# Production runtime: Node 24 on debian-slim with the bridge's runtime tool
# deps. Each entry is a subprocess target the TS bridge shells out to:
#   - ipmitool / freeipmi-tools  : oob/ipmi transport + per-vendor handlers
#   - nmap                       : bridge-network/network-scan.service
#   - iputils-arping             : vrrp/vrrp-reconciler.service (GARP on VIP bind)
#   - iputils-ping               : monitoring/icmp.service
#   - cpio                       : initrd/exec.ts (per-device initrd rebuild)
#   - iproute2                   : interface enumeration / netplan apply
#   - hdparm                     : lifecycle-deploy disk ops
#   - ssh                        : lifecycle-deploy + agent bootstrap fallback
#   - tini                       : zombie reaping for subprocess fan-out +
#                                  SIGTERM forwarding to the Node process so
#                                  main.ts's shutdownTrigger fires cleanly.
# Keep this list aligned with grep `child_process.spawn` in apps/bridge/src/.
FROM node:24-slim@sha256:03eae3ef7e88a9de535496fb488d67e02b9d96a063a8967bae657744ecd513f2 AS release
ENV NODE_ENV=production
ENV PATH="/usr/local/bin:$PATH"

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      cpio \
      curl \
      freeipmi-tools \
      hdparm \
      iproute2 \
      ipmitool \
      iputils-arping \
      iputils-ping \
      jq \
      nmap \
      openssh-client \
      tini && \
    rm -rf /var/lib/apt/lists/*

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
COPY apps/bridge/ca/ /build/ca/
RUN set -eux && \
    for cert in /build/ca/*.crt /build/ca/*.pem; do \
      [ -e "$cert" ] || continue; \
      base="$(basename "$cert")"; \
      install -m 444 "$cert" "/usr/local/share/ca-certificates/${base%.*}.crt"; \
    done && \
    rm -rf /build/ca && \
    update-ca-certificates
SHELL ["/bin/sh", "-c"]

# VERSION consumed late (BRIDGE_API_VERSION is runtime-read via process.env), so a
# version bump re-keys only the app-artifact layers below, not the apt/CA base above.
ARG VERSION
ENV BRIDGE_API_VERSION=${VERSION}

WORKDIR /app

# Bridge TS app: bundled dist + production node_modules + runtime assets.
COPY --from=bridge-build /bridge-deploy/node_modules ./node_modules
COPY --from=bridge-build /bridge-deploy/dist         ./dist
COPY --from=bridge-build /bridge-deploy/assets       ./assets

# AF_PACKET addon at exactly the path packet-socket.ts require()s: from dist/dhcp/l2 the relative
# `../../../native/afpacket/build/Release/afpacket.node` resolves to /app/native/... (dist sits at
# /app/dist). Absent → dgram-broadcast fallback; present → L2 fast path.
COPY --from=afpacket-build /afpacket/build/Release/afpacket.node ./native/afpacket/build/Release/afpacket.node

# gRPC proto definitions: the AgentService server loads agent.proto at runtime.
# grpc-transport.factory.ts resolves it relative to dist (../../../../../proto),
# which lands at the image root (/proto) since dist sits at /app/dist. Ship the
# whole tree so imported protos resolve via the include dirs too.
COPY --from=bridge-build /src/proto /proto

# License/attribution files for the distributed artifact.
COPY LICENSE NOTICE THIRD-PARTY-LICENSES.md ./

# Boot-time artifact bundles served by the bridge HTTP routes.
RUN mkdir -p /opt/brokkr/initrd-builds /opt/brokkr/ipxe-builds /opt/brokkr/agent
COPY --from=initrd-build        /build/brokkr-live.img    /opt/brokkr/initrd-builds/brokkr-live.img
COPY --from=bridge-agent-initrd /build/bridge-agent.img   /opt/brokkr/initrd-builds/bridge-agent.img
COPY --from=ipxe-amd64          /export/amd64/            /opt/brokkr/ipxe-builds/amd64/
COPY --from=ipxe-arm64          /export/arm64/            /opt/brokkr/ipxe-builds/arm64/
COPY --from=ipxe-iso            /export/ipxe.iso          /opt/brokkr/ipxe-builds/ipxe.iso
COPY --from=grub-build          /export/                  /app/assets/download/grub/
COPY --from=agent-build         /src/apps/live-agent/dist/main.js  /opt/brokkr/agent/main.js
COPY apps/live-agent/systemd/brokkr-bridge-agent.service /opt/brokkr/agent/brokkr-bridge-agent.service

COPY --chmod=755 apps/bridge/entrypoint.sh /entrypoint.sh

# tini reaps zombies from ipmitool/nmap/cpio subprocess fan-out and forwards
# SIGTERM/SIGINT to the Node process so the orchestrator's graceful-shutdown
# path (main.ts: setupProcessExceptionHandler + shutdownTrigger) runs.
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["start"]
