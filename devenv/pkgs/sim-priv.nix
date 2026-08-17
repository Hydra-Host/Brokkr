# brokkr-sim-priv — the single privileged helper the local-sim fleet shells out to as root.
# Replaces the per-op sudoers arg-globs (which sudo-rs on Ubuntu 25.10+ can't express, and which
# fnmatch made looser than intended) with one bare-path NOPASSWD rule (modules/sudo.nix) whose
# scope is enforced IN CODE here. Built as an immutable writeShellApplication so the store path is
# the security boundary; the only host-specific value baked in is the pinned ipmi_sim store path
# (the ipmi-launch verb execs it). Everything else resolves to absolute system tools at runtime,
# PATH-independent — sudo-rs forces env_reset. See sim-priv.sh for the verb contract + invariants.
{
  lib,
  stdenv,
  writeShellApplication,
  openipmi,
  util-linux,
}:
writeShellApplication {
  name = "brokkr-sim-priv";
  # No runtimeInputs: the helper resolves every tool by absolute path itself (it must call the
  # SYSTEM ifconfig/ip/systemctl/pkill, not nixpkgs copies), so PATH is never trusted.
  text = ''
    IPMI_SIM=${lib.escapeShellArg "${openipmi}/bin/ipmi_sim"}
    export IPMI_SIM
  ''
  # flock is the exception to the system-tools rule above: that rule exists for tools that read or
  # mutate HOST state, where a nixpkgs copy would talk to the wrong thing. flock is a pure utility
  # over an fd we already hold, so pinning it is strictly more deterministic — and on NixOS (and in
  # the CI toolchain image) neither /usr/bin/flock nor /bin/flock exists to resolve. Linux-only:
  # util-linux does not build on darwin, and lib.optionalString's untaken branch is never forced.
  + lib.optionalString stdenv.isLinux ''
    FLOCK=${lib.escapeShellArg "${util-linux}/bin/flock"}
    export FLOCK
  ''
  + builtins.readFile ./sim-priv.sh;
}
