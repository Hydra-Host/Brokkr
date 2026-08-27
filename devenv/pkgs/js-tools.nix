# Single source of truth for the JS toolchain (node + pnpm), imported by BOTH
# devenv.nix (languages.javascript) and devenv/flake.nix (the CI ciImage) so the
# local dev shell and the CI toolchain image resolve the same node/pnpm and can't
# drift. node is the declared runtime (no mise.toml); pnpm is pinned to match
# package.json's packageManager (pnpm@8.x). Mirrors the python-env.nix pattern.
#
# Note: pnpm runs under its own bundled node (the pin's default `nodejs-slim`), so pnpm-driven
# work (install scripts, node-gyp, `pnpm run`) uses that while direct `node` invocations use
# `nodejs` below. This holds identically in dev and CI because both consume this file.
#
# Keep pnpm equal to package.json's `packageManager`: managePackageManagerVersions is off, so a
# mismatch is a silent skew rather than a re-exec of the pinned version.
{ pkgs }:
{
  nodejs = pkgs.nodejs_24;
  pnpm = pkgs.pnpm_11;
}
