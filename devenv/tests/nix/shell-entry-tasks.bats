setup() {
  cd "$BATS_TEST_DIRNAME/../../.."
  . devenv/lib/bats-helpers.bash
  export SECRETSPEC_REASON="pin the shell-entry task graph"
}

@test "the git-hooks install still runs before shell entry" {
  run devenv_task_edges
  [ "$status" -eq 0 ]
  printf '%s\n' "$output" | grep -qx 'devenv:git-hooks:install|devenv:enterShell|devenv:files'
}

@test "the test-environment task never follows shell entry" {
  run devenv_task_edges
  [ "$status" -eq 0 ]
  printf '%s\n' "$output" | grep -qx 'devenv:enterTest||'
}

@test "the whole-repo hook run never precedes the test-environment task" {
  run devenv_task_edges
  [ "$status" -eq 0 ]
  printf '%s\n' "$output" | grep -qx 'devenv:git-hooks:run||devenv:git-hooks:install'
}
