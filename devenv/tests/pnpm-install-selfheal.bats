setup() {
  cd "$BATS_TEST_DIRNAME/../.."
  . devenv/lib/bats-helpers.bash
  ROOT="$PWD"
  FIXTURE="$BATS_TEST_TMPDIR/repo"
  export PNPM_LOG="$BATS_TEST_TMPDIR/pnpm.log"
  export TMPDIR="$BATS_TEST_TMPDIR"
  mkdir -p "$FIXTURE"
  : >"$PNPM_LOG"
  printf '{"name":"fixture"}\n' >"$FIXTURE/package.json"
  printf 'lockfileVersion: 9.0\n' >"$FIXTURE/pnpm-lock.yaml"
  touch -t 202001010000 "$FIXTURE/pnpm-lock.yaml"
  mock_bin node 'exit 1'
  mock_pnpm 0
}

mock_pnpm() { # <install-exit-code>
  local body
  body=$(
    cat <<STUB
if [ "\$1" = "--version" ]; then echo 0.0.0; exit 0; fi
printf '%s\n' "\$*" >>"\$PNPM_LOG"
if [ "$1" != 0 ]; then echo "gyp ERR! build error"; fi
exit $1
STUB
  )
  mock_bin pnpm "$body"
}

mock_find_purge_failure() {
  local body real
  real=$(command -v find)
  body=$(
    cat <<STUB
case " \$* " in
*" -prune "*)
  echo "rm: cannot remove './node_modules': Directory not empty" >&2
  exit 1
  ;;
esac
exec $real "\$@"
STUB
  )
  mock_bin find "$body"
}

fresh_modules_dir() {
  mkdir -p "$FIXTURE/node_modules"
  printf 'hoistPattern:\n' >"$FIXTURE/node_modules/.modules.yaml"
}

linked_turbo() {
  mkdir -p "$FIXTURE/node_modules/.bin"
  printf 'exit 0\n' >"$FIXTURE/node_modules/.bin/turbo"
  chmod +x "$FIXTURE/node_modules/.bin/turbo"
}

install_run() {
  run bash -c 'cd "$1" && bash "$2/devenv/scripts/brokkr-pnpm-install.sh"' _ "$FIXTURE" "$ROOT"
}

pnpm_install_calls() {
  grep -c '^install' "$PNPM_LOG" || true
}

@test "a fresh .modules.yaml over an unlinked tree does not count as up to date" {
  fresh_modules_dir
  install_run
  [ "$status" -eq 0 ]
  [[ "$output" != *"node_modules up-to-date; skipping install"* ]]
  [ "$(pnpm_install_calls)" -eq 1 ]
}

@test "a fresh .modules.yaml over a linked tree does skip the install" {
  fresh_modules_dir
  linked_turbo
  install_run
  [ "$status" -eq 0 ]
  [[ "$output" == *"node_modules up-to-date; skipping install"* ]]
  [ "$(pnpm_install_calls)" -eq 0 ]
}

@test "a lockfile newer than .modules.yaml still forces an install with turbo linked" {
  fresh_modules_dir
  linked_turbo
  touch "$FIXTURE/pnpm-lock.yaml"
  install_run
  [ "$status" -eq 0 ]
  [[ "$output" != *"node_modules up-to-date; skipping install"* ]]
  [ "$(pnpm_install_calls)" -eq 1 ]
}

@test "a purge that cannot remove node_modules fails loudly and does not reinstall" {
  mock_pnpm 1
  mock_find_purge_failure
  mkdir -p "$FIXTURE/node_modules"
  install_run
  [ "$status" -ne 0 ]
  [[ "$output" == *"could not purge node_modules"* ]]
  [ "$(pnpm_install_calls)" -eq 1 ]
}

@test "a purge that succeeds still retries the install once" {
  mock_pnpm 1
  mkdir -p "$FIXTURE/node_modules"
  install_run
  [ "$status" -ne 0 ]
  [[ "$output" != *"could not purge node_modules"* ]]
  [ "$(pnpm_install_calls)" -eq 2 ]
}
