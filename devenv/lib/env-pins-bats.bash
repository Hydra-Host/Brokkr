#!/usr/bin/env bash
# shellcheck shell=bash
#
# Sandbox builder shared by the three env-pins suites. The renderer is a standalone script, so
# every case that only exercises rendering runs it against a copied tree and never the checkout.
#
# Requires devenv/lib/bats-helpers.bash to be sourced first (for repo_root).

scratch_root() {
  local dir root
  root="$(repo_root)"
  dir=$(mktemp -d)
  mkdir -p "$dir/devenv/scripts"
  cp "$root/devenv/scripts/render-env-pins.sh" "$dir/devenv/scripts/"
  cp "$root/devenv/env-pin-aliases.txt" "$dir/devenv/"
  chmod +x "$dir/devenv/scripts/render-env-pins.sh"
  printf '%s' "$dir"
}
