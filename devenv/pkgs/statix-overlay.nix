# statix ships in nixpkgs 26.05 as an unstable snapshot whose insta snapshot tests are flaky on
# aarch64-darwin — roughly one build in three dies, and it is a different test file each time
# (empty_list_concat, then deprecated_to_path), so skipping named tests does not settle it. A
# failed statix build takes the whole treefmt wrapper with it, which breaks `pnpm format`, the
# pre-commit gate and the CI format job. Skip the upstream suite; statix itself is unaffected.
_final: prev: {
  statix = prev.statix.overrideAttrs (_: {
    doCheck = false;
  });
}
