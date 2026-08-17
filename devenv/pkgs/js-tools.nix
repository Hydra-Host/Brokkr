# Single source of truth for the JS toolchain (node + pnpm), imported by BOTH
# devenv.nix (languages.javascript) and devenv/flake.nix (the CI ciImage) so the
# local dev shell and the CI toolchain image resolve the same node/pnpm and can't
# drift. node is the declared runtime (no mise.toml); pnpm is pinned to match
# package.json's packageManager (pnpm@8.x). Mirrors the python-env.nix pattern.
#
# Note: pnpm_8 itself runs under its own bundled node (the pin's default `nodejs`,
# currently v22) — so pnpm-driven work (install scripts, node-gyp, `pnpm run`) uses
# v22 while direct `node` invocations use `nodejs` below. This holds identically in
# dev and CI because both consume this file.
{ pkgs }:
{
  nodejs = pkgs.nodejs_24;
  pnpm = pkgs.pnpm_8;
}
