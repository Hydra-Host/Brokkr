
setup() {
  cd "$BATS_TEST_DIRNAME/../.."
  REAL_RM=$(command -v rm)
  SANDBOX=$(mktemp -d)
  export REAL_RM SANDBOX
  export MOCKLOG="$SANDBOX/mock.log"
  export HOME="$SANDBOX/home"
  export XDG_STATE_HOME="$SANDBOX/state"
  export DEVENV_STATE="$SANDBOX/devenv-state"
  export DEVENV_ROOT="$SANDBOX/devenv-root"
  export LOCAL_SIM_PRIV_BIN="$SANDBOX/local-sim-priv"
  MOCKBIN="$SANDBOX/bin"
  mkdir -p "$HOME/.local/share" "$XDG_STATE_HOME" "$DEVENV_STATE" "$MOCKBIN" \
    "$DEVENV_ROOT/apps/local-sim" "$SANDBOX/tmp" "$SANDBOX/opt/brokkr"
  : >"$MOCKLOG"
  for cmd in stack-down stack-await-down stack-wipe-data; do
    printf '#!/usr/bin/env bash\necho "%s $*" >> "$MOCKLOG"\nexit 0\n' "$cmd" >"$MOCKBIN/$cmd"
  done
  printf '#!/usr/bin/env bash\n' >"$MOCKBIN/sudo"
  cat >>"$MOCKBIN/sudo" <<'EOF'
echo "sudo $*" >> "$MOCKLOG"
case "$*" in
"-n $LOCAL_SIM_PRIV_BIN noop") exit 0 ;;
-n*) exit 1 ;;
esac
exit 0
EOF
  printf '#!/usr/bin/env bash\n' >"$MOCKBIN/python"
  cat >>"$MOCKBIN/python" <<'EOF'
echo "python $* LOCAL_STATE=${LOCAL_STATE:-} SIM_SLOT=${SIM_SLOT:-}" >> "$MOCKLOG"
EOF
  printf '#!/usr/bin/env bash\n' >"$MOCKBIN/rm"
  cat >>"$MOCKBIN/rm" <<'EOF'
echo "rm $*" >> "$MOCKLOG"
opts=()
paths=()
for a in "$@"; do
  case "$a" in
  -*) opts+=("$a") ;;
  "$SANDBOX"/*) paths+=("$a") ;;
  /*) paths+=("$SANDBOX$a") ;;
  *) paths+=("$SANDBOX/$a") ;;
  esac
done
exec "$REAL_RM" "${opts[@]}" "${paths[@]}"
EOF
  chmod +x "$MOCKBIN"/*
  export PATH="$MOCKBIN:$PATH"
  . devenv/lib/stack-registry.sh
}

teardown() {
  "$REAL_RM" -rf "$SANDBOX"
}

seed_stack() {
  local slot=$1 suffix=""
  [ "$slot" = 0 ] || suffix="-s$slot"
  printf '%s' "$slot" >"$DEVENV_STATE/stack-slot-applied"
  mkdir -p "$SANDBOX/tmp/brokkr-dev$suffix" "$SANDBOX/opt/brokkr/agent$suffix" \
    "$HOME/.local/share/local$suffix"
  stack_registry_claim "$slot" "$PWD" "$SANDBOX/devenv-runtime" >/dev/null
}

@test "release removes the slot's spoke storage, agent bundle and sim state roots" {
  seed_stack 7
  bash devenv/scripts/stack-release.sh
  [ ! -e "$SANDBOX/tmp/brokkr-dev-s7" ]
  [ ! -e "$SANDBOX/opt/brokkr/agent-s7" ]
  [ ! -e "$HOME/.local/share/local-s7" ]
  [ ! -e "$DEVENV_STATE/stack-slot-applied" ]
  [ ! -e "$XDG_STATE_HOME/brokkr-local/stacks/stack-7.json" ]
}

@test "release spares the roots and registry entries of other slots" {
  seed_stack 7
  mkdir -p "$SANDBOX/tmp/brokkr-dev-s1" "$SANDBOX/opt/brokkr/agent-s1" \
    "$HOME/.local/share/local-s1"
  stack_registry_claim 1 "$SANDBOX/other-checkout" "$SANDBOX/other-runtime" >/dev/null
  mkdir -p "$SANDBOX/other-checkout"
  bash devenv/scripts/stack-release.sh
  [ -d "$SANDBOX/tmp/brokkr-dev-s1" ]
  [ -d "$SANDBOX/opt/brokkr/agent-s1" ]
  [ -d "$HOME/.local/share/local-s1" ]
  [ -e "$XDG_STATE_HOME/brokkr-local/stacks/stack-1.json" ]
}

@test "release of a non-zero slot spares slot 0's legacy roots" {
  seed_stack 7
  mkdir -p "$SANDBOX/tmp/brokkr-dev" "$SANDBOX/opt/brokkr/agent" "$HOME/.local/share/local"
  bash devenv/scripts/stack-release.sh
  [ -d "$SANDBOX/tmp/brokkr-dev" ]
  [ -d "$SANDBOX/opt/brokkr/agent" ]
  [ -d "$HOME/.local/share/local" ]
}

@test "release refuses when no applied slot stamp exists" {
  run bash devenv/scripts/stack-release.sh
  [ "$status" -ne 0 ]
  [[ "$output" == *"no applied slot stamp"* ]]
  [ ! -s "$MOCKLOG" ]
}

@test "release prints usage for --help and tears nothing down" {
  seed_stack 7
  : >"$MOCKLOG"
  run bash devenv/scripts/stack-release.sh --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"usage: stack-release"* ]]
  [ ! -s "$MOCKLOG" ]
  [ -d "$SANDBOX/tmp/brokkr-dev-s7" ]
  [ -f "$DEVENV_STATE/stack-slot-applied" ]
  [ -e "$XDG_STATE_HOME/brokkr-local/stacks/stack-7.json" ]
}

@test "release refuses an unrecognized argument and tears nothing down" {
  seed_stack 7
  : >"$MOCKLOG"
  run bash devenv/scripts/stack-release.sh bogus
  [ "$status" -ne 0 ]
  [[ "$output" == *"unexpected argument 'bogus'"* ]]
  [ ! -s "$MOCKLOG" ]
  [ -d "$SANDBOX/tmp/brokkr-dev-s7" ]
  [ -f "$DEVENV_STATE/stack-slot-applied" ]
  [ -e "$XDG_STATE_HOME/brokkr-local/stacks/stack-7.json" ]
}

@test "release gates the slot's bootptab sweep on the helper, not on an allowlisted command" {
  seed_stack 7
  bash devenv/scripts/stack-release.sh
  run grep -F "sudo -n $LOCAL_SIM_PRIV_BIN noop" "$MOCKLOG"
  [ "$status" -eq 0 ]
  run grep -F "sudo $LOCAL_SIM_PRIV_BIN bootptab-section-remove brokkr-slot-7" "$MOCKLOG"
  [ "$status" -eq 0 ]
  run grep -F 'sudo -n true' "$MOCKLOG"
  [ "$status" -ne 0 ]
}

@test "reslot still accepts its documented no-argument invocation" {
  seed_stack 7
  bash devenv/scripts/stack-reslot.sh
  [ ! -e "$SANDBOX/tmp/brokkr-dev-s7" ]
  [ ! -e "$XDG_STATE_HOME/brokkr-local/stacks/stack-7.json" ]
}
