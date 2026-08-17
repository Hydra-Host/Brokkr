
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
  for cmd in stack-down stack-await-down stack-wipe-data sudo; do
    printf '#!/usr/bin/env bash\necho "%s $*" >> "$MOCKLOG"\nexit 0\n' "$cmd" >"$MOCKBIN/$cmd"
  done
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

log_line() {
  local match
  match=$(grep -n "$1" "$MOCKLOG" | head -1)
  [ -n "$match" ] || return 1
  printf '%s' "${match%%:*}"
}

@test "reslot removes the old slot's spoke storage, agent bundle and sim state roots" {
  seed_stack 7
  bash devenv/scripts/stack-reslot.sh
  [ ! -e "$SANDBOX/tmp/brokkr-dev-s7" ]
  [ ! -e "$SANDBOX/opt/brokkr/agent-s7" ]
  [ ! -e "$HOME/.local/share/local-s7" ]
}

@test "reslot off slot 0 removes the legacy unsuffixed roots and spares other slots" {
  seed_stack 0
  mkdir -p "$SANDBOX/tmp/brokkr-dev-s1" "$SANDBOX/opt/brokkr/agent-s1" \
    "$HOME/.local/share/local-s1"
  bash devenv/scripts/stack-reslot.sh
  [ ! -e "$SANDBOX/tmp/brokkr-dev" ]
  [ ! -e "$SANDBOX/opt/brokkr/agent" ]
  [ ! -e "$HOME/.local/share/local" ]
  [ -d "$SANDBOX/tmp/brokkr-dev-s1" ]
  [ -d "$SANDBOX/opt/brokkr/agent-s1" ]
  [ -d "$HOME/.local/share/local-s1" ]
}

@test "reslot off a non-zero slot spares slot 0's legacy roots" {
  seed_stack 7
  mkdir -p "$SANDBOX/tmp/brokkr-dev" "$SANDBOX/opt/brokkr/agent" "$HOME/.local/share/local"
  bash devenv/scripts/stack-reslot.sh
  [ -d "$SANDBOX/tmp/brokkr-dev" ]
  [ -d "$SANDBOX/opt/brokkr/agent" ]
  [ -d "$HOME/.local/share/local" ]
}

@test "reslot nukes under the old slot's env, then removes its roots, then releases the slot" {
  seed_stack 7
  bash devenv/scripts/stack-reslot.sh
  run log_line "local.fleet nuke LOCAL_STATE=$HOME/.local/share/local-s7 SIM_SLOT=7"
  [ "$status" -eq 0 ]
  nuke=$output
  run log_line '^rm -rf /tmp/brokkr-dev-s7'
  [ "$status" -eq 0 ]
  purge=$output
  run log_line 'stacks/stack-7\.json'
  [ "$status" -eq 0 ]
  release=$output
  [ "$nuke" -lt "$purge" ]
  [ "$purge" -lt "$release" ]
}
