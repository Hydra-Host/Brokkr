# socket_vmnet isn't in the pinned nixpkgs rev, so build it from the lima-vm
# source. It's what lets a rootless qemu reach Apple's vmnet bridge (via
# -netdev stream over the UNIX socket it owns); daemons.py sudo-launches the
# binary by absolute path, so devenv only needs to hand config.py the store
# path via LOCAL_SOCKET_VMNET_BIN. Darwin-only — Linux uses libvirt's native
# bridge instead.
{
  lib,
  stdenv,
  fetchFromGitHub,
  apple-sdk_26,
}:
stdenv.mkDerivation (finalAttrs: {
  pname = "socket_vmnet";
  # Pinned past v1.2.2 for --vmnet-disable-dhcp (PR #165, decouples vmnet DHCP from bootpd).
  # Needs apple-sdk_26 buildInput: the vmnet_network_configuration_* API is guarded by
  # __MAC_OS_X_VERSION_MAX_ALLOWED >= 260000 (default stdenv 11.3 SDK compiles it out).
  # TODO: move to the next upstream release tag when one lands; keep apple-sdk_26.
  version = "1.2.2-unstable-2026-07-21";

  src = fetchFromGitHub {
    owner = "lima-vm";
    repo = "socket_vmnet";
    rev = "7af3d336920fe09f992054d9e79e1ca2687a5002"; # merge commit of PR #165
    hash = "sha256-5leL5B5XUQCKRVH2dbI6P03J4zNjpjbgzyGZCDCHMYc=";
  };

  # Build against the macOS 26 SDK (not the stdenv default 11.3) so the compile-time guard admits
  # the vmnet_network_configuration_* path behind `--vmnet-disable-dhcp`.
  buildInputs = [ apple-sdk_26 ];

  # Local patch: --vmnet-serialize-to (owner) + --vmnet-join-from (joiner) for per-VM isolation
  # on the single-owner vmnet API (macOS-26 vmnet_network_create). Drop if/when upstreamed.
  patches = [ ./socket_vmnet-shared-network.patch ];

  # the Makefile derives VERSION from `git describe`; the fetched tarball has no
  # .git, so pin it explicitly to keep the build pure.
  makeFlags = [ "VERSION=v${finalAttrs.version}" ];

  # the Makefile's install.bin target shells out to `logger`, which isn't in the
  # build sandbox — copy the two built binaries directly instead.
  installPhase = ''
    runHook preInstall
    install -Dm755 socket_vmnet socket_vmnet_client -t $out/bin
    runHook postInstall
  '';

  meta = {
    description = "vmnet.framework support for unprivileged QEMU on macOS";
    homepage = "https://github.com/lima-vm/socket_vmnet";
    license = lib.licenses.asl20;
    platforms = lib.platforms.darwin;
    mainProgram = "socket_vmnet";
  };
})
