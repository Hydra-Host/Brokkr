setup() {
  cd "$BATS_TEST_DIRNAME/../.."
  . devenv/lib/bats-helpers.bash
  GUARD_MODULE=devenv/modules/agent-tooling.nix
  GUARD_FN=$(sed -n '/^      guard_decision() {/,/^      }$/p' "$GUARD_MODULE")
  export GUARD_MODULE GUARD_FN
}

guard() {
  run bash -c 'set -euo pipefail; eval "$GUARD_FN"; guard_decision "$1"' _ "$1"
}

assert_allowed() {
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

assert_denied() {
  [ "$status" -eq 0 ]
  [[ "$output" == *"$1"* ]]
}

@test "the extracted decision is the shipped hook's, wired as a PreToolUse hook on Bash" {
  [ -n "$GUARD_FN" ]
  [[ "$GUARD_FN" == *'guard_decision() {'* ]]
  [[ "$GUARD_FN" == *'printf'* ]]
  run grep -F 'pkgs.jq' "$GUARD_MODULE"
  [ "$status" -eq 0 ]
  run grep -F '.tool_input.command' "$GUARD_MODULE"
  [ "$status" -eq 0 ]
  run grep -F 'permissionDecision: "deny"' "$GUARD_MODULE"
  [ "$status" -eq 0 ]
  run grep -F 'hookEventName: "PreToolUse"' "$GUARD_MODULE"
  [ "$status" -eq 0 ]
  run grep -F 'hookType = "PreToolUse"' "$GUARD_MODULE"
  [ "$status" -eq 0 ]
  run grep -F 'matcher = "Bash"' "$GUARD_MODULE"
  [ "$status" -eq 0 ]
  run grep -F 'claude-host-wide-stack-guard' "$GUARD_MODULE"
  [ "$status" -eq 0 ]
}

@test "a single-command rg of a doc naming down:all is allowed" {
  guard 'rg "task down:all" devenv/README.md'
  assert_allowed
}

@test "a single-command grep of the taskfile naming purge:all is allowed" {
  guard 'grep -n "purge:all" Taskfile.yml'
  assert_allowed
}

@test "a single-command sed range of the taskfile is allowed" {
  guard 'sed -n "160,180p" Taskfile.yml'
  assert_allowed
}

@test "a git log search for down:all is allowed" {
  guard 'git log --oneline --grep="down:all"'
  assert_allowed
}

@test "a semicolon carrying down:all after a read is denied" {
  guard 'grep x f; task down:all'
  assert_denied "stops EVERY checkout's stack"
}

@test "an and-list carrying down:all after a read is denied" {
  guard 'grep x f && task down:all'
  assert_denied "stops EVERY checkout's stack"
}

@test "a bare ampersand backgrounding a read before down:others is denied" {
  guard 'grep x f & task down:others'
  assert_denied "stops other checkouts' stacks"
}

@test "a pipe from a read into purge:all is denied" {
  guard 'echo hi | task purge:all'
  assert_denied "wipes EVERY registered slot's data"
}

@test "backtick substitution of purge:all inside a read is denied" {
  guard 'cat `task purge:all`'
  assert_denied "wipes EVERY registered slot's data"
}

@test "dollar-paren substitution of purge:all inside a read is denied" {
  guard 'cat $(task purge:all)'
  assert_denied "wipes EVERY registered slot's data"
}

@test "awk reaching down:all through BEGIN system is denied" {
  guard "awk 'BEGIN{system(\"task down:all\")}'"
  assert_denied "stops EVERY checkout's stack"
}

@test "a second line carrying down:all under a first-line read is denied" {
  guard 'rg "task down:all" devenv/README.md
task down:all'
  assert_denied "stops EVERY checkout's stack"
}

@test "task down:all on its own is denied" {
  guard 'task down:all'
  assert_denied "stops EVERY checkout's stack"
}

@test "down:all behind a cd is denied" {
  guard 'cd /repo && task down:all'
  assert_denied "stops EVERY checkout's stack"
}

@test "the stack-purge-all script is denied" {
  guard 'stack-purge-all'
  assert_denied "wipes EVERY registered slot's data"
}

@test "a recursive bats run over devenv/tests is denied" {
  guard 'bats -r devenv/tests'
  assert_denied "devenv/tests/checkout writes into a real checkout"
}

@test "a bats run of a checkout-tier file is denied" {
  guard 'bats devenv/tests/checkout/foo.bats'
  assert_denied "devenv/tests/checkout writes into a real checkout"
}

@test "task test:devenv:all is denied" {
  guard 'task test:devenv:all'
  assert_denied "the devenv checkout bats tier"
}

@test "a named container-safe bats file is allowed" {
  guard 'bats devenv/tests/stack-release.bats'
  assert_allowed
}

@test "task stack:release is allowed" {
  guard 'task stack:release'
  assert_allowed
}

@test "task down is allowed" {
  guard 'task down'
  assert_allowed
}

@test "the whole hook wraps a denied command in a PreToolUse deny envelope" {
  jq --version >/dev/null 2>&1 || skip "no jq on PATH; the shipped hook gets one from runtimeInputs"
  body=$(sed -n "/^ *text = ''\$/,/^ *'';\$/p" "$GUARD_MODULE" | sed '1d;$d')
  mock_bin claude-host-wide-stack-guard "$(printf 'set -euo pipefail\n%s\n' "$body")"

  jq -n '{tool_input: {command: "task down:all"}}' >"$BATS_TEST_TMPDIR/deny.json"
  run bash -c 'claude-host-wide-stack-guard <"$1"' _ "$BATS_TEST_TMPDIR/deny.json"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.hookSpecificOutput.hookEventName')" = PreToolUse ]
  [ "$(printf '%s' "$output" | jq -r '.hookSpecificOutput.permissionDecision')" = deny ]
  reason=$(printf '%s' "$output" | jq -r '.hookSpecificOutput.permissionDecisionReason')
  [[ "$reason" == *"stops EVERY checkout's stack"* ]]

  jq -n '{tool_input: {command: "task down"}}' >"$BATS_TEST_TMPDIR/allow.json"
  run bash -c 'claude-host-wide-stack-guard <"$1"' _ "$BATS_TEST_TMPDIR/allow.json"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
