
HELPER=/nix/store/aaaaaaaaaaaa1111-brokkr-sim-priv/bin/brokkr-sim-priv
NAME=brokkr-sim-aaaaaaaaaaaa

setup() {
  cd "$BATS_TEST_DIRNAME/../.."
  . devenv/lib/bats-helpers.bash
  isolated_state
  export MOCKLOG="$BATS_TEST_TMPDIR/mocklog"
  export BROKKR_SUDOERS_D="$BATS_TEST_TMPDIR/sudoers.d"
  export LOCAL_SIM_PRIV_BIN="$HELPER"
  mkdir -p "$BROKKR_SUDOERS_D"
  new_checkout a
  mock_bin visudo 'exit 0'
  mock_bin sudo '
case "$*" in
"-n -v") exit "${FAKE_SUDO_NV:-0}" ;;
-k\ -n\ *noop) exit "${FAKE_SUDO_K:-0}" ;;
-n\ *noop) exit "${FAKE_SUDO_N:-0}" ;;
-n\ *dropin-current*) exit "${FAKE_DROPIN:-127}" ;;
-v) exit 0 ;;
esac
echo "sudo $*" >>"$MOCKLOG"
args=()
while [ $# -gt 0 ]; do
  case "$1" in
  -o | -g) shift 2 ;;
  *)
    args+=("$1")
    shift
    ;;
  esac
done
exec "${args[@]}"'
}

new_checkout() {
  export DEVENV_ROOT="$BATS_TEST_TMPDIR/co-$1"
  export DEVENV_STATE="$DEVENV_ROOT/.devenv/state"
  mkdir -p "$DEVENV_ROOT/.sudoers" "$DEVENV_STATE"
  render_with "$HELPER"
}

render_with() {
  printf '# generated\n# __USER__ note\n__USER__ ALL=(root) NOPASSWD: %s, %s, /usr/bin/true\n' \
    "$HELPER" "$1" >"$DEVENV_ROOT/.sudoers/brokkr-sim"
}

run_install() {
  run bash devenv/scripts/install-sim-sudoers.sh
}

global_marker() {
  printf '%s\n' "${XDG_STATE_HOME}/brokkr-local/sudoers/$NAME.rev"
}

same() {
  [ "$(<"$1")" = "$(<"$2")" ]
}

@test "a second checkout with no local state takes the silent fast path" {
  run_install
  [ "$status" -eq 0 ]
  [ -e "$BROKKR_SUDOERS_D/$NAME" ]
  same "$BROKKR_SUDOERS_D/$NAME" "$(global_marker)"

  new_checkout b
  : >"$MOCKLOG"
  run_install
  [ "$status" -eq 0 ]
  [[ "$output" == *"already current"* ]]
  run grep -c 'install' "$MOCKLOG"
  [ "$output" -eq 0 ]
}

@test "a socket_vmnet-only rotation still refuses the fast path" {
  run_install
  [ "$status" -eq 0 ]
  render_with /nix/store/bbbbbbbbbbbb2222-socket_vmnet/bin/socket_vmnet
  : >"$MOCKLOG"
  run_install
  [ "$status" -eq 0 ]
  [[ "$output" != *"already current"* ]]
  run grep -c 'install' "$MOCKLOG"
  [ "$output" -ge 1 ]
  run grep -c 'socket_vmnet' "$(global_marker)"
  [ "$output" -eq 1 ]
}

@test "a pre-relocation local marker is migrated, not trusted" {
  install -m 0644 /dev/null "$BROKKR_SUDOERS_D/$NAME"
  sed "s/__USER__/$(id -un)/g" "$DEVENV_ROOT/.sudoers/brokkr-sim" >"$BATS_TEST_TMPDIR/r"
  mkdir -p "$DEVENV_STATE/sudoers"
  cp "$BATS_TEST_TMPDIR/r" "$DEVENV_STATE/sudoers/$NAME.rev"

  run_install
  [ "$status" -eq 0 ]
  [[ "$output" != *"already current"* ]]
  [ -e "$(global_marker)" ]
  [ ! -d "$DEVENV_STATE/sudoers" ]
}

@test "the local marker tree is swept even when the fast path is taken" {
  run_install
  [ "$status" -eq 0 ]
  mkdir -p "$DEVENV_STATE/sudoers"
  touch "$DEVENV_STATE/sudoers/stale.rev"
  run_install
  [ "$status" -eq 0 ]
  [[ "$output" == *"already current"* ]]
  [ ! -d "$DEVENV_STATE/sudoers" ]
}

@test "the marker falls back to HOME when XDG_STATE_HOME is unset" {
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME"
  unset XDG_STATE_HOME
  run_install
  [ "$status" -eq 0 ]
  [ -e "$HOME/.local/state/brokkr-local/sudoers/$NAME.rev" ]
}

@test "a legacy unhashed drop-in overrides a matching marker" {
  run_install
  [ "$status" -eq 0 ]
  touch "$BROKKR_SUDOERS_D/brokkr-sim"
  : >"$MOCKLOG"
  run_install
  [ "$status" -eq 0 ]
  [[ "$output" != *"already current"* ]]
}

@test "a failing authorisation probe overrides a matching marker" {
  run_install
  [ "$status" -eq 0 ]
  : >"$MOCKLOG"
  FAKE_SUDO_N=1 run_install
  [ "$status" -eq 0 ]
  [[ "$output" != *"already current"* ]]
}

@test "a failing post-install verify exits nonzero and writes no marker" {
  FAKE_SUDO_K=1 run_install
  [ "$status" -eq 1 ]
  [[ "$output" == *"does not authorise"* ]]
  [ ! -e "$(global_marker)" ]
}

@test "a helper outside the nix store is refused" {
  export LOCAL_SIM_PRIV_BIN=/usr/local/bin/brokkr-sim-priv
  run_install
  [ "$status" -eq 1 ]
  [[ "$output" == *"not a /nix/store path"* ]]
}

@test "a render pinning another helper is refused and writes no marker" {
  printf '__USER__ ALL=(root) NOPASSWD: /nix/store/cccccccccccc3333-brokkr-sim-priv/bin/brokkr-sim-priv\n' \
    >"$DEVENV_ROOT/.sudoers/brokkr-sim"
  run_install
  [ "$status" -eq 1 ]
  [[ "$output" == *"pins a different helper"* ]]
  [ ! -e "$(global_marker)" ]
}

@test "the marker records the substituted user, never the placeholder" {
  run_install
  [ "$status" -eq 0 ]
  run grep -c __USER__ "$(global_marker)"
  [ "$output" -eq 0 ]
  run grep -c "$(id -un)" "$(global_marker)"
  [ "$output" -ge 1 ]
}

@test "a sibling drop-in whose helper left the store is collected" {
  printf '%s ALL=(root) NOPASSWD: /nix/store/dddddddddddd4444-brokkr-sim-priv/bin/brokkr-sim-priv\n' \
    "$(id -un)" >"$BROKKR_SUDOERS_D/brokkr-sim-dddddddddddd"
  run_install
  [ "$status" -eq 0 ]
  [ ! -e "$BROKKR_SUDOERS_D/brokkr-sim-dddddddddddd" ]
}

@test "a sibling drop-in on the legacy alias format is collected" {
  printf 'Cmnd_Alias BROKKR_PRIV = /bin/true\n' >"$BROKKR_SUDOERS_D/brokkr-sim-eeeeeeeeeeee"
  run_install
  [ "$status" -eq 0 ]
  [ ! -e "$BROKKR_SUDOERS_D/brokkr-sim-eeeeeeeeeeee" ]
}

@test "an unparseable sibling drop-in survives the sweep" {
  printf 'nothing we recognise\n' >"$BROKKR_SUDOERS_D/brokkr-sim-ffffffffffff"
  run_install
  [ "$status" -eq 0 ]
  [ -e "$BROKKR_SUDOERS_D/brokkr-sim-ffffffffffff" ]
}

@test "the helper answering current takes the fast path with no readable drop-in" {
  run_install
  [ "$status" -eq 0 ]
  rm -f "$BROKKR_SUDOERS_D/$NAME" "$(global_marker)"
  : >"$MOCKLOG"
  FAKE_DROPIN=0 run_install
  [ "$status" -eq 0 ]
  [[ "$output" == *"already current"* ]]
  run grep -c 'install' "$MOCKLOG"
  [ "$output" -eq 0 ]
}

@test "the helper answering not-current reinstalls even when the marker matches" {
  run_install
  [ "$status" -eq 0 ]
  same "$BROKKR_SUDOERS_D/$NAME" "$(global_marker)"
  : >"$MOCKLOG"
  FAKE_DROPIN=3 run_install
  [ "$status" -eq 0 ]
  [[ "$output" != *"already current"* ]]
  run grep -c 'install' "$MOCKLOG"
  [ "$output" -ge 1 ]
}

@test "a helper that cannot be run falls back to the marker" {
  run_install
  [ "$status" -eq 0 ]
  : >"$MOCKLOG"
  FAKE_DROPIN=1 run_install
  [ "$status" -eq 0 ]
  [[ "$output" == *"already current"* ]]
}

@test "a helper that cannot be run and an unreadable drop-in reinstalls" {
  run_install
  [ "$status" -eq 0 ]
  rm -f "$BROKKR_SUDOERS_D/$NAME"
  : >"$MOCKLOG"
  FAKE_DROPIN=1 run_install
  [ "$status" -eq 0 ]
  [[ "$output" != *"already current"* ]]
}

@test "the render lands under the marker directory so the helper can resolve it" {
  run_install
  [ "$status" -eq 0 ]
  run grep -c "${XDG_STATE_HOME}/brokkr-local/sudoers/.render" "$MOCKLOG"
  [ "$output" -ge 1 ]
}
