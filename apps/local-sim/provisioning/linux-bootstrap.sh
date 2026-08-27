#!/bin/bash
# brok-local Linux host packages. Sourced by bootstrap.sh, which calls
# linux_host_packages — this file runs nothing at source time.
#
# Nix/devenv owns the toolchain (python+sushy, ruff, node, pnpm, uv,
# go-task, tmux, vault, qemu/libvirt/ovmf/dnsmasq/cpio CLIs, ...). This function
# installs only what Nix can't own on a non-NixOS host: the OS-level system
# libvirtd + KVM access (the stack connects to qemu:///system — see
# host_os.libvirt_uri()) + firmware blobs + docker (the grub-build + iPXE-build
# containers — grub2 is Linux-only and can't come from Nix on Darwin, so the
# build is uniform docker on both hosts). Nix + direnv come from the dispatcher.

# One rule for every slot. LOCAL_STATE is slot-derived (~/.local/share/local, then -s<N>), and the
# AppArmor block only re-runs when the bootstrap sha changes, so a per-slot rule silently misses.
_overlay_rule_glob() {
  local root=${LOCAL_STATE:-$HOME/.local/share/local}
  case "$root" in
  *-s[0-9] | *-s[0-9][0-9]) root=${root%-s*} ;;
  esac
  printf '%s{,-s[0-9],-s[0-9][0-9]}/disks/overlays\n' "$root"
}

# Run libvirt's qemu sub-process as the current user (default is libvirt-qemu), so qemu can read the
# NVRAM/overlay files brok-local writes under $HOME — Ubuntu's /home/$USER is mode 750 and would
# otherwise give "Permission denied".
_configure_qemu_conf() {
  local QEMU_CONF=${BROKK_BOOTSTRAP_QEMU_CONF:-/etc/libvirt/qemu.conf}
  if [ ! -f "$QEMU_CONF" ]; then
    return 0
  fi
  if sudo grep -qE "^[[:space:]]*user[[:space:]]*=[[:space:]]*\"$USER\"" "$QEMU_CONF" 2>/dev/null; then
    return 0
  fi
  echo "==> configure libvirt qemu to run as $USER (was libvirt-qemu)"
  # Backup taken once: an in-place `sed -i.brokk-bak` rewrites it per entry, so a second run
  # would overwrite the pristine original. `.brokk-tmp` is for portability — a bare `-i` is GNU-only.
  if [ ! -f "$QEMU_CONF.brokk-bak" ]; then
    sudo cp "$QEMU_CONF" "$QEMU_CONF.brokk-bak"
  fi
  sudo sed -i.brokk-tmp \
    -e "s/^#*user[[:space:]]*=.*/user = \"$USER\"/" \
    -e "s/^#*group[[:space:]]*=.*/group = \"$USER\"/" \
    "$QEMU_CONF"
  sudo rm -f "$QEMU_CONF.brokk-tmp"
  sudo systemctl restart libvirtd 2>/dev/null || sudo systemctl restart libvirt 2>/dev/null || true
}

# A wedged docker daemon makes `docker buildx version` hang forever, and this runs during
# bootstrap — before host-access-check.sh's own bounded probes exist to protect the bring-up.
_buildx_ok() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "${BROKK_BOOTSTRAP_TIMEOUT:-5}" docker buildx version >/dev/null 2>&1
  else
    docker buildx version >/dev/null 2>&1
  fi
}

# One package name, its own transaction, then a re-probe. Never fold a buildx name into the
# nine-package install above: one unknown name aborts that whole transaction.
_install_buildx_pkg() { # <distro> <pkg> — 0 once `docker buildx` answers
  case "$1" in
  apt) sudo apt-get install -y --no-install-recommends "$2" || true ;;
  dnf) sudo dnf install -y "$2" || true ;;
  pacman) sudo pacman -S --needed --noconfirm "$2" || true ;;
  esac
  _buildx_ok
}

# The plugin ships apart from the engine under a different name per distribution. The last resort
# links the Nix-pinned one by its devenv profile path, which survives a store-path rotation.
ensure_docker_buildx() {
  local distro=${1:-} profile plugin_dir
  plugin_dir="${DOCKER_CONFIG:-$HOME/.docker}/cli-plugins"
  if _buildx_ok; then
    echo "  ✓ docker buildx plugin present"
    return 0
  fi

  echo "==> install the docker buildx plugin (the iPXE + grub images build with buildx)"
  case "$distro" in
  apt)
    if ! _install_buildx_pkg apt docker-buildx; then
      _install_buildx_pkg apt docker-buildx-plugin || true
    fi
    ;;
  dnf)
    if ! _install_buildx_pkg dnf moby-buildx; then
      _install_buildx_pkg dnf docker-buildx || true
    fi
    ;;
  pacman)
    _install_buildx_pkg pacman docker-buildx || true
    ;;
  esac
  if _buildx_ok; then
    echo "  ✓ docker buildx plugin installed"
    return 0
  fi

  profile="${DEVENV_ROOT:-}/.devenv/profile/bin/docker-buildx"
  if [ -n "${DEVENV_ROOT:-}" ] && [ -x "$profile" ]; then
    mkdir -p "$plugin_dir"
    ln -sf "$profile" "$plugin_dir/docker-buildx"
    echo "  ✓ linked the devenv's docker-buildx into $plugin_dir"
    return 0
  fi

  echo "  ⚠ no docker buildx plugin available from $distro, and none in the devenv profile." >&2
  echo "    The iPXE + grub boot binaries build with 'docker buildx' and will fail without it." >&2
  echo "    Install it by hand: put the buildx release binary at" >&2
  echo "    $plugin_dir/docker-buildx (or /usr/libexec/docker/cli-plugins/docker-buildx), chmod +x." >&2
  return 0
}

linux_host_packages() {
  local ARCH DISTRO AA_DAEMON AA_QEMU OVERLAYS aa_changed f
  ARCH=$(uname -m)
  case "$ARCH" in
  x86_64 | aarch64) echo "→ Linux $ARCH" ;;
  *)
    echo "❌ Unsupported Linux arch: $ARCH (need x86_64 or aarch64)" >&2
    return 1
    ;;
  esac

  if command -v apt-get >/dev/null 2>&1; then
    DISTRO=apt
  elif command -v dnf >/dev/null 2>&1; then
    DISTRO=dnf
  elif command -v pacman >/dev/null 2>&1; then
    DISTRO=pacman
  else
    echo "❌ Unsupported package manager (need apt, dnf, or pacman)." >&2
    echo "   Install the OS-level virt stack yourself, then re-run:" >&2
    echo "     libvirt daemon + clients, qemu (system emulators), OVMF/edk2 UEFI firmware," >&2
    echo "     bridge-utils, dnsmasq, docker." >&2
    echo "   Then: enable libvirtd + docker (systemctl --now), and add yourself to the" >&2
    echo "   libvirt/kvm/docker groups (log out + back in for it to take effect)." >&2
    return 1
  fi
  echo "→ package manager: $DISTRO"

  # Sudo cache once upfront. `-n -v` asks whether a credential is held; never `-n true`, which the
  # sim sudoers drop-in allowlists NOPASSWD — it reports success and primes nothing.
  if ! sudo -n -v 2>/dev/null; then
    sudo -v
  fi

  echo "==> install OS-level virt daemon + KVM + firmware + docker"
  case "$DISTRO" in
  apt)
    sudo apt-get update -qq
    sudo apt-get install -y --no-install-recommends \
      libvirt-daemon-system \
      libvirt-clients \
      qemu-system-x86 \
      qemu-system-arm \
      ovmf \
      bridge-utils \
      dnsmasq-base \
      curl \
      ca-certificates
    # arm64-efi UEFI firmware ships as a separate package on Debian/Ubuntu.
    sudo apt-get install -y --no-install-recommends qemu-efi-aarch64 || true
    # distro docker.io conflicts with an existing docker-ce/containerd.io (download.docker.com)
    # stack via the containerd↔containerd.io relationship — only install it when no docker is
    # already present, so we never clobber or fail against the host's own docker.
    if command -v docker >/dev/null 2>&1; then
      echo "  ✓ docker already on PATH ($(command -v docker)); skipping docker.io install"
    else
      sudo apt-get install -y --no-install-recommends docker.io
    fi
    ;;
  dnf)
    sudo dnf install -y \
      libvirt \
      qemu-kvm \
      edk2-ovmf \
      bridge-utils \
      dnsmasq \
      curl
    # moby-engine conflicts with an existing docker-ce from Docker's yum repo — same guard as apt.
    if command -v docker >/dev/null 2>&1; then
      echo "  ✓ docker already on PATH ($(command -v docker)); skipping moby-engine install"
    else
      sudo dnf install -y moby-engine
    fi
    ;;
  pacman)
    # Arch is rolling: `pacman -Sy <pkg>` (partial upgrade) AND reinstalling an
    # already-present package against a newer repo build both break versioned inter-deps
    # (e.g. bumping qemu-system-x86 alone breaks the installed qemu-base that pins
    # qemu-common to the old version). So install ONLY genuinely-missing packages: pacman -T
    # prints unsatisfied targets (honoring provides), leaving present ones (qemu, nftables,
    # …) untouched. nftables (not iptables-nft) is libvirt's default NAT backend and, unlike
    # iptables-nft, doesn't conflict with a standalone ebtables.
    local MISSING
    mapfile -t MISSING < <(pacman -T \
      libvirt \
      qemu-system-x86 \
      qemu-system-aarch64 \
      edk2-ovmf \
      edk2-aarch64 \
      iproute2 \
      dnsmasq \
      nftables \
      docker \
      curl \
      ca-certificates)
    if [ "${#MISSING[@]}" -gt 0 ]; then
      echo "→ installing missing: ${MISSING[*]}"
      if ! sudo pacman -S --needed --noconfirm "${MISSING[@]}"; then
        echo "❌ pacman install failed — your system is likely behind the repos." >&2
        echo "   Run a full upgrade first: sudo pacman -Syu  (then re-run 'task up')." >&2
        return 1
      fi
    else
      echo "  ✓ required virt packages already present (nothing to install)"
    fi
    ;;
  esac

  echo "==> ensure libvirtd + docker running + user in libvirt/kvm/docker groups"
  sudo systemctl enable --now libvirtd 2>/dev/null || sudo systemctl enable --now libvirt 2>/dev/null || true
  sudo systemctl enable --now docker 2>/dev/null || true
  for g in libvirt kvm docker; do
    # skip groups that don't exist (e.g. a snap/rootless docker that never created a 'docker'
    # group) — usermod would otherwise error and abort the set -e bootstrap.
    getent group "$g" >/dev/null 2>&1 || continue
    if ! id -nG "$USER" | tr ' ' '\n' | grep -qx "$g"; then
      sudo usermod -aG "$g" "$USER"
      echo "  → added $USER to '$g' group. Log out and back in (or reboot) before you run 'task up'."
    fi
  done

  _configure_qemu_conf

  # AppArmor (Debian/Ubuntu) confines libvirtd and each guest's qemu to system paths, so
  # the devenv's setup needs local allow-rules:
  #   - /nix/store/** — the rendered domain XML's <emulator>/<loader>/<nvram> point into
  #     the Nix store (LOCAL_QEMU_EMULATOR/LOCAL_EDK2_*), so the daemon must probe-exec the
  #     Nix qemu and each guest must read the Nix EDK2 blobs. the glob survives a
  #     `devenv update` rotating the store path.
  #   - emulated-NVMe overlays — they ride a qemu:commandline -drive (libvirt has no
  #     bus='nvme'), and the per-domain profile only whitelists <disk> elements, not
  #     commandline files, so qemu is denied the overlay without this rule.
  # no-op on non-AppArmor hosts (Fedora/SELinux, Arch-sans-apparmor, NixOS).
  AA_DAEMON=/etc/apparmor.d/local/usr.sbin.libvirtd
  AA_QEMU=/etc/apparmor.d/local/abstractions/libvirt-qemu
  OVERLAYS=$(_overlay_rule_glob)
  if [ -d /etc/apparmor.d/abstractions ]; then
    aa_changed=
    sudo install -d /etc/apparmor.d/local /etc/apparmor.d/local/abstractions
    for f in "$AA_DAEMON" "$AA_QEMU"; do
      sudo grep -Fqs '/nix/store/** rmix' "$f" && continue
      echo "==> AppArmor: allow Nix-store qemu + EDK2 (/nix/store/** rmix) in $(basename "$f")"
      printf '# brok-local: devenv runs qemu + EDK2 firmware from the Nix store\n/nix/store/** rmix,\n' | sudo tee -a "$f" >/dev/null
      aa_changed=1
    done
    if ! sudo grep -Fqs "$OVERLAYS/*-d" "$AA_QEMU" 2>/dev/null; then
      echo "==> AppArmor: allow fleet-builder NVMe overlays ($OVERLAYS/*-d*.img)"
      printf '# brok-local fleet builder: emulated-NVMe overlays (qemu:commandline -drive)\n"%s/*-d*.img" rwk,\n' "$OVERLAYS" | sudo tee -a "$AA_QEMU" >/dev/null
      aa_changed=1
    fi
    [ -n "$aa_changed" ] && sudo systemctl reload apparmor 2>/dev/null || true
  fi

  ensure_docker_buildx "$DISTRO"
}
