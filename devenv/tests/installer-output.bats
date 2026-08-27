setup() {
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_PREFIX
  cd "$BATS_TEST_DIRNAME/../.."
  . devenv/lib/bats-helpers.bash
}

fixture_repo() {
  [ -n "$1" ]
  rm -rf "$1"
  mkdir -p "$1"
  git init -q "$1"
  [ -d "$1/.git" ]
  [ -z "${2:-}" ] || git -C "$1" --git-dir="$1/.git" remote add origin "$2"
}

stub_key() {
  mkdir -p "$(dirname "$1")"
  printf -- '-----BEGIN OPENSSH PRIVATE KEY-----\nstub\n-----END OPENSSH PRIVATE KEY-----\n' >"$1"
  chmod 600 "$1"
}

@test "install.sh can be sourced as a library without running main" {
  run env BROKKR_INSTALL_LIB=1 sh -c '. ./install.sh; echo SOURCED_OK'
  [ "$status" -eq 0 ]
  [[ "$output" == *"SOURCED_OK"* ]]
  [[ "$output" != *"Brokkr local-stack installer"* ]]
}

@test "colors are empty when stdout is not a terminal" {
  run env BROKKR_INSTALL_LIB=1 sh -c '. ./install.sh; setup_colors; printf "[%s]" "$C_GREEN"'
  [ "$status" -eq 0 ]
  [ "$output" = "[]" ]
}

@test "colors are empty when NO_COLOR is set even on a terminal" {
  run pty_run env NO_COLOR=1 TERM=xterm BROKKR_INSTALL_LIB=1 \
    sh -c '. ./install.sh; setup_colors; printf "[%s]" "$C_GREEN"'
  [ "$status" -eq 0 ]
  [[ "$output" == *"[]"* ]]
}

@test "colors are populated on a terminal without NO_COLOR" {
  run pty_run env -u NO_COLOR TERM=xterm BROKKR_INSTALL_LIB=1 \
    sh -c '. ./install.sh; setup_colors; printf "[%s]" "$C_GREEN"'
  [ "$status" -eq 0 ]
  [[ "$output" != *"[]"* ]]
}

@test "elapsed formats minutes and zero-padded seconds" {
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh
    now=$(date +%s)
    elapsed $((now - 247))
  '
  [ "$status" -eq 0 ]
  [ "$output" = "4m07s" ]
}

@test "file_mtime returns an epoch for an existing file" {
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh
    f=$(mktemp)
    m=$(file_mtime "$f")
    rm -f "$f"
    case "$m" in "" | *[!0-9]*) exit 1 ;; esac
    echo MTIME_OK
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"MTIME_OK"* ]]
}

@test "file_mtime falls through when stat rejects the gnu flag" {
  mock_bin stat '
if [ "$1" = "-c" ]; then exit 1; fi
if [ "$1" = "-f" ] && [ "$2" = "%m" ]; then echo 1700000000; exit 0; fi
exit 1'
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh
    m="$(file_mtime ./install.sh)"
    echo "mtime=$m"
    echo MTIME_FALLBACK_OK
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"mtime=1700000000"* ]]
  [[ "$output" == *"MTIME_FALLBACK_OK"* ]]
}

@test "file_mode falls through when stat rejects the gnu flag" {
  mock_bin stat '
if [ "$1" = "-c" ]; then exit 1; fi
if [ "$1" = "-f" ] && [ "$2" = "%Lp" ]; then echo 640; exit 0; fi
exit 1'
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh
    m="$(file_mode ./install.sh)"
    echo "mode=$m"
    echo MODE_FALLBACK_OK
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"mode=640"* ]]
  [[ "$output" == *"MODE_FALLBACK_OK"* ]]
}

@test "the ticker keeps reporting on a host without gnu stat" {
  mock_bin stat '
if [ "$1" = "-c" ]; then exit 1; fi
if [ "$1" = "-f" ] && [ "$2" = "%m" ]; then echo 1700000000; exit 0; fi
exit 1'
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh
    init_phase_state
    PROGRESS_INTERVAL=1
    printf "Evaluating shell\n" > "$PHASE_FILE"
    begin_step "building"
    sleep 3
    stop_ticker
    cleanup
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"still: Evaluating shell"* ]]
}

@test "filter keeps devenv phase markers and drops noise" {
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh
    init_phase_state
    filter_devenv_line "• Evaluating shell"
    filter_devenv_line "attr_path: nixpkgs, fingerprint: deadbeef"
    filter_devenv_line "Stored eval result in cache"
    filter_devenv_line "✓ Evaluating shell in 12.1s"
    cleanup
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"Evaluating shell"* ]]
  [[ "$output" != *"attr_path"* ]]
  [[ "$output" != *"Stored eval result"* ]]
}

@test "filter records the current phase label for the ticker" {
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh
    init_phase_state
    filter_devenv_line "• Evaluating shell"
    cat "$PHASE_FILE"
    cleanup
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"Evaluating shell"* ]]
}

@test "filter tolerates a marker line that carries ansi colour" {
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh
    init_phase_state
    esc=$(printf "\033")
    filter_devenv_line "${esc}[34m•${esc}[0m Configuring shell"
    cat "$PHASE_FILE"
    cleanup
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"Configuring shell"* ]]
}

@test "a completed marker clears the phase so the ticker cannot report a finished step" {
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh
    init_phase_state
    filter_devenv_line "• Running tasks"
    filter_devenv_line "✓ Running tasks in 857ms"
    printf "[%s]" "$(cat "$PHASE_FILE")"
    cleanup
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"[]"* ]]
}

@test "begin_step_quiet starts no ticker" {
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh
    init_phase_state
    PROGRESS_INTERVAL=1
    printf "Running tasks in 857ms\n" > "$PHASE_FILE"
    begin_step_quiet "onboarding"
    sleep 3
    cleanup
  '
  [ "$status" -eq 0 ]
  [[ "$output" != *"still:"* ]]
}

@test "ticker names the current phase during silence" {
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh
    init_phase_state
    PROGRESS_INTERVAL=1
    printf "Evaluating shell\n" > "$PHASE_FILE"
    begin_step "building"
    sleep 3
    stop_ticker
    cleanup
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"still: Evaluating shell"* ]]
}

@test "ticker stays quiet while output is flowing" {
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh
    init_phase_state
    PROGRESS_INTERVAL=2
    begin_step "building"
    i=0
    while [ $i -lt 8 ]; do
      sleep 0.5
      printf "Evaluating shell\n" > "$PHASE_FILE"
      i=$((i + 1))
    done
    stop_ticker
    cleanup
  '
  [ "$status" -eq 0 ]
  [[ "$output" != *"still:"* ]]
}

@test "init_phase_state creates a phase file that cleanup removes" {
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh
    init_phase_state
    [ -f "$PHASE_FILE" ] || exit 1
    saved="$PHASE_DIR"
    cleanup
    [ -d "$saved" ] && exit 1
    echo PHASE_STATE_OK
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"PHASE_STATE_OK"* ]]
}

@test "to_ssh_url rewrites an https remote to the scp spelling" {
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh; to_ssh_url "https://github.com/Hydra-Host/Brokkr.git"
  '
  [ "$status" -eq 0 ]
  [ "$output" = "git@github.com:Hydra-Host/Brokkr.git" ]
}

@test "to_ssh_url strips embedded userinfo" {
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh; to_ssh_url "https://user@github.com/o/r.git"
  '
  [ "$output" = "git@github.com:o/r.git" ]
}

@test "to_ssh_url leaves ssh, scp and file remotes untouched" {
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh
    to_ssh_url "git@github.com:o/r.git"
    to_ssh_url "ssh://git@github.com/o/r.git"
    to_ssh_url "file:///tmp/x"
  '
  [[ "$output" == *"git@github.com:o/r.git"* ]]
  [[ "$output" == *"ssh://git@github.com/o/r.git"* ]]
  [[ "$output" == *"file:///tmp/x"* ]]
}

@test "the rewritten default still normalizes equal to the https default" {
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh
    a="$(normalize_git_url "$DEFAULT_REPO_URL")"
    b="$(normalize_git_url "$(to_ssh_url "$DEFAULT_REPO_URL")")"
    [ "$a" = "$b" ] && echo ADOPT_SAFE
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"ADOPT_SAFE"* ]]
}

@test "resolve_ssh_url rewrites the default remote" {
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh; REPO_URL="$DEFAULT_REPO_URL"; resolve_ssh_url; echo "$REPO_URL"
  '
  [ "$status" -eq 0 ]
  [ "$output" = "git@github.com:Hydra-Host/Brokkr.git" ]
}

@test "resolve_ssh_url refuses an explicitly supplied https remote" {
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh; REPO_URL="https://example.invalid/o/r.git"; resolve_ssh_url
  '
  [ "$status" -eq 1 ]
  [[ "$output" == *"--repo git@example.invalid:o/r.git"* ]]
}

@test "resolve_ssh_url leaves a file remote alone" {
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh; REPO_URL="file:///tmp/x"; resolve_ssh_url; echo "$REPO_URL"
  '
  [ "$status" -eq 0 ]
  [ "$output" = "file:///tmp/x" ]
}

@test "resolve_ssh_key fails when the key path does not exist" {
  run env BROKKR_INSTALL_LIB=1 HOME="$BATS_TEST_TMPDIR" sh -c '
    . ./install.sh; SSH_KEY="$HOME/nope"; resolve_ssh_key
  '
  [ "$status" -eq 1 ]
  [[ "$output" == *"no ssh key at"* ]]
}

@test "resolve_ssh_key rejects a public key file" {
  printf 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 t\n' >"$BATS_TEST_TMPDIR/k.pub"
  run env BROKKR_INSTALL_LIB=1 HOME="$BATS_TEST_TMPDIR" sh -c '
    . ./install.sh; SSH_KEY="$HOME/k.pub"; resolve_ssh_key
  '
  [ "$status" -eq 1 ]
  [[ "$output" == *"WITHOUT the .pub suffix"* ]]
}

@test "resolve_ssh_key tightens a world-readable key and says so" {
  stub_key "$BATS_TEST_TMPDIR/k"
  chmod 644 "$BATS_TEST_TMPDIR/k"
  run env BROKKR_INSTALL_LIB=1 HOME="$BATS_TEST_TMPDIR" sh -c '
    . ./install.sh; SSH_KEY="$HOME/k"; resolve_ssh_key; file_mode "$SSH_KEY"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"tightened"* ]]
  [[ "$output" == *"600"* ]]
}

@test "resolve_ssh_key makes a relative key path absolute" {
  stub_key "$BATS_TEST_TMPDIR/k"
  run env BROKKR_INSTALL_LIB=1 HOME="$BATS_TEST_TMPDIR" sh -c '
    cd "$HOME" || exit 1
    . '"$PWD"'/install.sh
    SSH_KEY=./k
    resolve_ssh_key
    echo "$SSH_KEY"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == /* ]]
}

@test "known_hosts pins github and appending is idempotent" {
  stub_key "$BATS_TEST_TMPDIR/k"
  run env BROKKR_INSTALL_LIB=1 HOME="$BATS_TEST_TMPDIR" sh -c '
    . ./install.sh
    SSH_KEY="$HOME/k"
    resolve_ssh_key
    ensure_known_hosts
    grep -c "^github.com ssh-ed25519 " "$KNOWN_HOSTS_FILE"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"1"* ]]
}

@test "git_ssh_command quotes a key path containing a space" {
  stub_key "$BATS_TEST_TMPDIR/my keys/k"
  run env BROKKR_INSTALL_LIB=1 HOME="$BATS_TEST_TMPDIR" sh -c '
    . ./install.sh; SSH_KEY="$HOME/my keys/k"; resolve_ssh_key; git_ssh_command
  '
  [ "$status" -eq 0 ]
  expected="'$BATS_TEST_TMPDIR/my keys/k'"
  [[ "$output" == *"$expected"* ]]
}

@test "ssh parses the constructed command and offers exactly one identity" {
  command -v ssh >/dev/null 2>&1 || skip "no ssh"
  stub_key "$BATS_TEST_TMPDIR/k"
  run env BROKKR_INSTALL_LIB=1 HOME="$BATS_TEST_TMPDIR" sh -c '
    . ./install.sh
    SSH_KEY="$HOME/k"
    resolve_ssh_key
    eval "$(git_ssh_command) -G github.com" | grep -E "^(identityfile|identitiesonly) "
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"identitiesonly yes"* ]]
  [ "$(printf '%s\n' "$output" | grep -c '^identityfile ')" -eq 1 ]
}

@test "git_ssh_command reads no ssh config and speaks to no agent" {
  stub_key "$BATS_TEST_TMPDIR/k"
  run env BROKKR_INSTALL_LIB=1 HOME="$BATS_TEST_TMPDIR" sh -c '
    . ./install.sh; SSH_KEY="$HOME/k"; resolve_ssh_key; git_ssh_command
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"ssh -F none -o IdentityAgent=none -i "* ]]
  [[ "$output" == *"-o IdentitiesOnly=yes"* ]]
}

@test "IdentitiesOnly alone leaves an identity an ssh config names for the host" {
  command -v ssh >/dev/null 2>&1 || skip "no ssh"
  stub_key "$BATS_TEST_TMPDIR/k"
  printf 'Host github.com\n  IdentityFile %s/other\n' "$BATS_TEST_TMPDIR" >"$BATS_TEST_TMPDIR/config"
  run ssh -G -F "$BATS_TEST_TMPDIR/config" -i "$BATS_TEST_TMPDIR/k" -o IdentitiesOnly=yes github.com
  [ "$status" -eq 0 ]
  [ "$(printf '%s\n' "$output" | grep -c '^identityfile ')" -eq 2 ]
  run ssh -G -F none -o IdentityAgent=none -i "$BATS_TEST_TMPDIR/k" -o IdentitiesOnly=yes github.com
  [ "$status" -eq 0 ]
  [ "$(printf '%s\n' "$output" | grep -c '^identityfile ')" -eq 1 ]
}

@test "ssh takes the user config from the passwd home, so HOME never poisons it in a test" {
  command -v ssh >/dev/null 2>&1 || skip "no ssh"
  stub_key "$BATS_TEST_TMPDIR/k"
  mkdir -p "$BATS_TEST_TMPDIR/.ssh"
  printf 'Host github.com\n  IdentityFile %s/poison\n' "$BATS_TEST_TMPDIR" >"$BATS_TEST_TMPDIR/.ssh/config"
  run env HOME="$BATS_TEST_TMPDIR" ssh -G -i "$BATS_TEST_TMPDIR/k" -o IdentitiesOnly=yes github.com
  [ "$status" -eq 0 ]
  [[ "$output" != *"/poison"* ]]
}

@test "ssh_host_of names the host of an ssh remote and nothing for the rest" {
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh
    for u in "git@github.com:o/r.git" "ssh://git@example.com:2222/o/r.git" \
      "https://github.com/o/r.git" "file:///tmp/x" "/tmp/x"; do
      printf "[%s]\n" "$(ssh_host_of "$u")"
    done
  '
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "[github.com]" ]
  [ "${lines[1]}" = "[example.com]" ]
  [ "${lines[2]}" = "[]" ]
  [ "${lines[3]}" = "[]" ]
  [ "${lines[4]}" = "[]" ]
}

@test "the clone failure hint names the remote's own host, never github by default" {
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh; SSH_KEY=/tmp/dk; REPO_URL="git@example.com:o/r.git"; clone_failed
  '
  [ "$status" -eq 1 ]
  [[ "$output" == *"ssh -F none -o IdentityAgent=none -i /tmp/dk -o IdentitiesOnly=yes -T git@example.com"* ]]
}

@test "the clone failure hint is omitted when ssh is not the transport" {
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh; SSH_KEY=/tmp/dk; REPO_URL="file:///tmp/x"; clone_failed
  '
  [ "$status" -eq 1 ]
  [[ "$output" != *"check it"* ]]
  [[ "$output" == *"an ssh key works over ssh only"* ]]
}

log_env() {
  printf 'BROKKR_INSTALL_LIB=1 HOME=%s XDG_STATE_HOME=%s' \
    "$BATS_TEST_TMPDIR/h" "$BATS_TEST_TMPDIR/state"
}

log_dir() {
  printf '%s/state/brokkr-local/logs' "$BATS_TEST_TMPDIR"
}

@test "a default run writes a timestamped log and points latest.log at it" {
  run env $(log_env) sh -c '. ./install.sh; parse_args; init_log; log_write hello'
  [ "$status" -eq 0 ]
  [ -f "$(log_dir)/latest.log" ]
  [ "$(ls "$(log_dir)"/install-*.log | wc -l | tr -d ' ')" -eq 1 ]
  [[ "$(cat "$(log_dir)/latest.log")" == *"hello"* ]]
}

@test "the log file is created 0600" {
  run env $(log_env) sh -c '. ./install.sh; parse_args; init_log; file_mode "$LOG_FILE"'
  [ "$status" -eq 0 ]
  [ "$output" = "600" ]
}

@test "the header names the argv and the host" {
  run env $(log_env) sh -c '. ./install.sh; parse_args --dir /tmp/x; init_log; log_header --dir /tmp/x'
  [ "$status" -eq 0 ]
  body="$(cat "$(log_dir)/latest.log")"
  [[ "$body" == *"brokkr installer log"* ]]
  [[ "$body" == *"--dir /tmp/x"* ]]
  [[ "$body" == *"uname"* ]]
}

@test "log_write strips colour so the file holds no escape sequences" {
  run env $(log_env) sh -c '
    . ./install.sh; parse_args; init_log
    C_DIM=$(printf "\033[2m"); C_RESET=$(printf "\033[0m")
    ok "stack up ${C_DIM}(total 4m07s)${C_RESET}"
  '
  [ "$status" -eq 0 ]
  [ -f "$(log_dir)/latest.log" ]
  run grep -c "$(printf '\033')" "$(log_dir)/latest.log"
  [ "$status" -ne 0 ]
}

@test "--log writes exactly that path and no sibling latest.log" {
  run env $(log_env) sh -c '. ./install.sh; parse_args --log '"$BATS_TEST_TMPDIR"'/custom/run.log; init_log; log_write hi'
  [ "$status" -eq 0 ]
  [ -f "$BATS_TEST_TMPDIR/custom/run.log" ]
  [ ! -e "$BATS_TEST_TMPDIR/custom/latest.log" ]
  [ ! -e "$BATS_TEST_TMPDIR/state" ]
}

@test "--no-log writes nothing at all" {
  run env $(log_env) sh -c '. ./install.sh; parse_args --no-log; init_log; log_write x; printf "[%s]" "$LOG_FILE"'
  [ "$status" -eq 0 ]
  [ "$output" = "[]" ]
  [ ! -e "$BATS_TEST_TMPDIR/state" ]
}

@test "--no-log outranks --log" {
  run env $(log_env) sh -c '. ./install.sh; parse_args --no-log --log '"$BATS_TEST_TMPDIR"'/nope.log; init_log; printf "[%s]" "$LOG_FILE"'
  [ "$status" -eq 0 ]
  [ "$output" = "[]" ]
  [ ! -e "$BATS_TEST_TMPDIR/nope.log" ]
}

@test "an unwritable log target warns once and keeps going" {
  touch "$BATS_TEST_TMPDIR/blocked"
  run env $(log_env) sh -c '
    . ./install.sh; parse_args --log '"$BATS_TEST_TMPDIR"'/blocked/deep/run.log
    init_log; printf "rc=%s LOG_FILE=[%s]" "$?" "$LOG_FILE"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"cannot write a log at"* ]]
  [[ "$output" == *"rc=0 LOG_FILE=[]"* ]]
}

@test "BROKKR_LOG_KEEP prunes the oldest logs and spares latest.log" {
  mkdir -p "$(log_dir)"
  for d in 01 02 03 04 05 06; do touch "$(log_dir)/install-202608${d}-000000.log"; done
  ln -s "$(log_dir)/install-20260806-000000.log" "$(log_dir)/latest.log"
  run env $(log_env) BROKKR_LOG_KEEP=3 sh -c '
    . ./install.sh; parse_args; LOG_DIR='"$(log_dir)"'; prune_logs
  '
  [ "$status" -eq 0 ]
  [ "$(ls "$(log_dir)"/install-*.log | wc -l | tr -d ' ')" -eq 3 ]
  [ -L "$(log_dir)/latest.log" ]
  [ -e "$(log_dir)/install-20260806-000000.log" ]
  [ ! -e "$(log_dir)/install-20260801-000000.log" ]
}

@test "a non-numeric BROKKR_LOG_KEEP is rejected" {
  run env $(log_env) BROKKR_LOG_KEEP=lots sh -c '. ./install.sh; parse_args'
  [ "$status" -eq 1 ]
  [[ "$output" == *"BROKKR_LOG_KEEP must be a whole number"* ]]
}

@test "print_log_hint names the log on stderr and stays quiet without one" {
  run env $(log_env) sh -c '. ./install.sh; LOG_FILE=/tmp/x.log; print_log_hint 2>&1'
  [ "$status" -eq 0 ]
  [[ "$output" == *"log: /tmp/x.log"* ]]

  run env $(log_env) sh -c '. ./install.sh; LOG_FILE=""; print_log_hint 2>&1; echo END'
  [ "$status" -eq 0 ]
  [ "$output" = "END" ]
}

@test "filter_devenv_line keeps markers on stdout while log_raw records every line" {
  run env $(log_env) sh -c '
    . ./install.sh; parse_args; init_log; init_phase_state
    for l in "NEEDLE plain line" "• Evaluating shell"; do
      log_raw "$l"
      filter_devenv_line "$l"
    done
    cleanup
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"Evaluating shell"* ]]
  [[ "$output" != *"NEEDLE"* ]]
  [[ "$(cat "$(log_dir)/latest.log")" == *"NEEDLE plain line"* ]]
}

sudo_stub() {
  export SUDO_LOG="$BATS_TEST_TMPDIR/sudo.log"
  export SUDO_PRIMED="$BATS_TEST_TMPDIR/sudo.primed"
  : >"$SUDO_LOG"
  mock_bin id '
case "$1" in
-u) echo 1000 ;;
-un) echo installer-test ;;
*) exit 1 ;;
esac'
  mock_bin sudo '
printf "%s\n" "$*" >>"$SUDO_LOG"
case "$*" in
"-n -v")
  [ -f "$SUDO_PRIMED" ] && exit 0
  exit 1
  ;;
"-n true") exit 0 ;;
"-v")
  [ -z "${SUDO_PRIME_OK:-}" ] || : >"$SUDO_PRIMED"
  exit 0
  ;;
esac
exit 0'
}

sleep_once() {
  export SLEEP_ONCE="$BATS_TEST_TMPDIR/slept"
  mock_bin sleep '
[ ! -f "$SLEEP_ONCE" ] || exit 1
: >"$SLEEP_ONCE"
exit 0'
}

prime_sudo_body() {
  printf '%s' '. ./install.sh
detect_tty
prime_sudo && rc=0 || rc=$?
printf "rc=%s keepalive=%s unprimed=%s\n" "$rc" "${SUDO_KEEPALIVE_PID:+set}" "${SUDO_UNPRIMED:+set}"
stop_keepalive'
}

sudo_calls() {
  grep -c -- "$1" "$SUDO_LOG" || true
}

@test "prime_sudo prompts for the credential an allowlisted command only pretends to hold" {
  sudo_stub
  sleep_once
  export SUDO_PRIME_OK=1
  run pty_run env BROKKR_INSTALL_LIB=1 sh -c "$(prime_sudo_body)"
  [ "$status" -eq 0 ]
  [[ "$output" == *"rc=0"* ]]
  [[ "$output" == *"keepalive=set"* ]]
  [[ "$output" == *"unprimed="* ]]
  [[ "$output" != *"unprimed=set"* ]]
  [ "$(sudo_calls '^-v$')" -eq 1 ]
  [ "$(sudo_calls '^-n true$')" -eq 0 ]
}

@test "prime_sudo stays silent when a credential is already cached" {
  sudo_stub
  sleep_once
  : >"$SUDO_PRIMED"
  run pty_run env BROKKR_INSTALL_LIB=1 sh -c "$(prime_sudo_body)"
  [ "$status" -eq 0 ]
  [[ "$output" == *"rc=0"* ]]
  [ "$(sudo_calls '^-v$')" -eq 0 ]
}

@test "prime_sudo reports a credential that sudo accepted but did not cache" {
  sudo_stub
  sleep_once
  run pty_run env BROKKR_INSTALL_LIB=1 sh -c "$(prime_sudo_body)"
  [ "$status" -eq 0 ]
  [[ "$output" == *"rc=1"* ]]
  [[ "$output" != *"keepalive=set"* ]]
  [[ "$output" == *"unprimed=set"* ]]
  [[ "$output" == *"did not cache"* ]]
}

@test "prime_sudo asks for nothing when the run is already root" {
  sudo_stub
  sleep_once
  mock_bin id '
case "$1" in
-u) echo 0 ;;
-un) echo root ;;
*) exit 1 ;;
esac'
  run pty_run env BROKKR_INSTALL_LIB=1 sh -c "$(prime_sudo_body)"
  [ "$status" -eq 0 ]
  [[ "$output" == *"rc=0"* ]]
  [[ "$output" != *"keepalive=set"* ]]
  [[ "$output" != *"unprimed=set"* ]]
  [ "$(sudo_calls '.')" -eq 0 ]
}

@test "the sudo keepalive refreshes the timestamp with -v" {
  sudo_stub
  sleep_once
  : >"$SUDO_PRIMED"
  run pty_run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh
    detect_tty
    prime_sudo
    wait "$SUDO_KEEPALIVE_PID" || true
    stop_keepalive
  '
  [ "$status" -eq 0 ]
  [ "$(sudo_calls '^-n -v$')" -ge 2 ]
  [ "$(sudo_calls '^-n true$')" -eq 0 ]
}

@test "the sudoers step drives task sudo:setup and stops the run when it fails" {
  export DEVENV_LOG="$BATS_TEST_TMPDIR/devenv.log"
  step_body='. ./install.sh
setup_colors
init_phase_state
TARGET_DIR=$PWD
HAVE_TTY=0
install_sim_sudoers
cleanup'
  mock_bin devenv 'echo "devenv $*" >> "$DEVENV_LOG"; exit 0'
  run env BROKKR_INSTALL_LIB=1 BROKKR_PROGRESS_INTERVAL=0 sh -c "$step_body"
  [ "$status" -eq 0 ]
  run grep -F 'task sudo:setup' "$DEVENV_LOG"
  [ "$status" -eq 0 ]

  mock_bin devenv 'exit 3'
  run env BROKKR_INSTALL_LIB=1 BROKKR_PROGRESS_INTERVAL=0 sh -c "$step_body"
  [ "$status" -eq 1 ]
  [[ "$output" == *"task sudo:setup failed"* ]]
}

@test "the onboarding step reads the stale-groups code as a checkpoint and exits zero" {
  step_body='. ./install.sh
setup_colors
init_phase_state
TARGET_DIR=$PWD
HAVE_TTY=0
PENDING_GROUPS="libvirt kvm"
run_onboarding
echo NOT_REACHED
cleanup'
  mock_bin devenv 'exit 78'
  run env BROKKR_INSTALL_LIB=1 BROKKR_PROGRESS_INTERVAL=0 sh -c "$step_body"
  [ "$status" -eq 0 ]
  [[ "$output" == *"new group membership needs a fresh login"* ]]
  [[ "$output" == *"You were added to: libvirt kvm"* ]]
  [[ "$output" != *"NOT_REACHED"* ]]
  [[ "$output" != *"task local:setup failed"* ]]
}

@test "the onboarding step reads a rewritten failure as a checkpoint while groups are pending" {
  step_body='. ./install.sh
setup_colors
init_phase_state
TARGET_DIR=$PWD
HAVE_TTY=0
PENDING_GROUPS="libvirt kvm docker"
run_onboarding
echo NOT_REACHED
cleanup'
  mock_bin devenv 'exit 201'
  run env BROKKR_INSTALL_LIB=1 BROKKR_PROGRESS_INTERVAL=0 sh -c "$step_body"
  [ "$status" -eq 0 ]
  [[ "$output" == *"new group membership needs a fresh login"* ]]
  [[ "$output" == *"You were added to: libvirt kvm docker"* ]]
  [[ "$output" != *"NOT_REACHED"* ]]
  [[ "$output" != *"task local:setup failed"* ]]
}

@test "the onboarding step still stops the run on any other non-zero" {
  step_body='. ./install.sh
setup_colors
init_phase_state
TARGET_DIR=$PWD
HAVE_TTY=0
run_onboarding
echo NOT_REACHED
cleanup'
  mock_bin devenv 'exit 3'
  run env BROKKR_INSTALL_LIB=1 BROKKR_PROGRESS_INTERVAL=0 sh -c "$step_body"
  [ "$status" -eq 1 ]
  [[ "$output" == *"task local:setup failed"* ]]
  [[ "$output" != *"NOT_REACHED"* ]]
  [[ "$output" != *"fresh login"* ]]
}

@test "tee_stack_log names its own phase so the ticker stays quiet while the stack talks" {
  run env BROKKR_INSTALL_LIB=1 BROKKR_NO_LOG=1 sh -c '
    . ./install.sh
    init_phase_state
    printf "Running tasks\n" > "$PHASE_FILE"
    printf "one\ntwo\n" | tee_stack_log
    printf "[%s]" "$(cat "$PHASE_FILE")"
    cleanup
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"one"* ]]
  [[ "$output" == *"two"* ]]
  [[ "$output" == *"[stack bring-up]"* ]]
}

@test "install.sh behaves identically under /bin/sh and bash" {
  sudo_stub
  sleep_once
  : >"$SUDO_PRIMED"
  mock_bin docker 'exit 0'
  mock_bin git 'exit 0'
  mock_bin curl 'exit 0'
  mock_bin xcode-select 'echo /Library/Developer/CommandLineTools'
  body=". ./install.sh
main --yes --stop-after deps --dir $BATS_TEST_TMPDIR/target"
  out_sh=$(pty_run env BROKKR_INSTALL_LIB=1 BROKKR_NO_LOG=1 BROKKR_PROGRESS_INTERVAL=0 NO_COLOR=1 \
    BODY="$body" /bin/sh -c 'eval "$BODY"' | tr -d '\r')
  rm -f "$SLEEP_ONCE"
  out_bash=$(pty_run env BROKKR_INSTALL_LIB=1 BROKKR_NO_LOG=1 BROKKR_PROGRESS_INTERVAL=0 NO_COLOR=1 \
    BODY="$body" bash -c 'eval "$BODY"' | tr -d '\r')
  [[ "$out_sh" == *"stopped after the 'deps' phase"* ]]
  [ "$out_sh" = "$out_bash" ]
}

@test "classify_target picks clone for a missing directory" {
  run env BROKKR_INSTALL_LIB=1 BROKKR_NO_LOG=1 TDIR="$BATS_TEST_TMPDIR/missing" sh -c '
    . ./install.sh
    TARGET_DIR="$TDIR"
    classify_target
    printf "state=%s origin=%s\n" "$TARGET_STATE" "$TARGET_ORIGIN"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"state=clone origin="* ]]
}

@test "classify_target picks clone for an existing empty directory" {
  mkdir -p "$BATS_TEST_TMPDIR/empty"
  run env BROKKR_INSTALL_LIB=1 BROKKR_NO_LOG=1 TDIR="$BATS_TEST_TMPDIR/empty" sh -c '
    . ./install.sh
    TARGET_DIR="$TDIR"
    classify_target
    printf "state=%s\n" "$TARGET_STATE"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"state=clone"* ]]
}

@test "classify_target refuses a target that is not a directory" {
  : >"$BATS_TEST_TMPDIR/afile"
  run env BROKKR_INSTALL_LIB=1 BROKKR_NO_LOG=1 TDIR="$BATS_TEST_TMPDIR/afile" sh -c '
    . ./install.sh
    TARGET_DIR="$TDIR"
    classify_target
  '
  [ "$status" -eq 1 ]
  [[ "$output" == *"exists and is not a directory"* ]]
}

@test "classify_target refuses a non-empty directory that is not a checkout" {
  mkdir -p "$BATS_TEST_TMPDIR/loose"
  : >"$BATS_TEST_TMPDIR/loose/README.md"
  run env BROKKR_INSTALL_LIB=1 BROKKR_NO_LOG=1 TDIR="$BATS_TEST_TMPDIR/loose" sh -c '
    . ./install.sh
    TARGET_DIR="$TDIR"
    classify_target
  '
  [ "$status" -eq 1 ]
  [[ "$output" == *"is not empty and is not a git checkout"* ]]
}

@test "classify_target stops on a checkout with no origin and prints the remote to add" {
  fixture_repo "$BATS_TEST_TMPDIR/mirror"
  run env BROKKR_INSTALL_LIB=1 BROKKR_NO_LOG=1 TDIR="$BATS_TEST_TMPDIR/mirror" sh -c '
    . ./install.sh
    TARGET_DIR="$TDIR"
    REPO_URL="$DEFAULT_REPO_URL"
    classify_target
  '
  [ "$status" -eq 1 ]
  [[ "$output" == *"no 'origin' remote"* ]]
  [[ "$output" == *"remote add origin https://github.com/Hydra-Host/Brokkr.git"* ]]
}

@test "classify_target adopts a checkout whose origin matches in the other spelling" {
  fixture_repo "$BATS_TEST_TMPDIR/checkout" git@github.com:Hydra-Host/Brokkr.git
  run env BROKKR_INSTALL_LIB=1 BROKKR_NO_LOG=1 TDIR="$BATS_TEST_TMPDIR/checkout" sh -c '
    . ./install.sh
    TARGET_DIR="$TDIR"
    REPO_URL="$DEFAULT_REPO_URL"
    classify_target
    printf "state=%s origin=%s\n" "$TARGET_STATE" "$TARGET_ORIGIN"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"state=adopt origin=git@github.com:Hydra-Host/Brokkr.git"* ]]
}

@test "classify_target refuses a checkout that tracks another repository" {
  fixture_repo "$BATS_TEST_TMPDIR/other" https://example.com/someone/else.git
  run env BROKKR_INSTALL_LIB=1 BROKKR_NO_LOG=1 TDIR="$BATS_TEST_TMPDIR/other" sh -c '
    . ./install.sh
    TARGET_DIR="$TDIR"
    REPO_URL="$DEFAULT_REPO_URL"
    classify_target
  '
  [ "$status" -eq 1 ]
  [[ "$output" == *"already tracks https://example.com/someone/else.git"* ]]
}

@test "classify_target defers the remote check when git is not installed yet" {
  fixture_repo "$BATS_TEST_TMPDIR/checkout"
  mkdir -p "$BATS_TEST_TMPDIR/nogit"
  ln -sf "$(command -v ls)" "$BATS_TEST_TMPDIR/nogit/ls"
  run env BROKKR_INSTALL_LIB=1 BROKKR_NO_LOG=1 PATH="$BATS_TEST_TMPDIR/nogit" \
    TDIR="$BATS_TEST_TMPDIR/checkout" /bin/sh -c '
    . ./install.sh
    TARGET_DIR="$TDIR"
    classify_target
    printf "state=%s origin=%s\n" "$TARGET_STATE" "$TARGET_ORIGIN"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"state=adopt origin="* ]]
}

@test "the plan says adopt, not clone into, for an existing checkout" {
  run env BROKKR_INSTALL_LIB=1 BROKKR_NO_LOG=1 NO_COLOR=1 sh -c '
    . ./install.sh
    TARGET_DIR=/example/boss
    TARGET_STATE=adopt
    TARGET_ORIGIN=git@github.com:Hydra-Host/Brokkr.git
    REPO_URL="$DEFAULT_REPO_URL"
    HOST_OS=macos
    print_plan
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"adopt      : /example/boss (tracks git@github.com:Hydra-Host/Brokkr.git)"* ]]
  [[ "$output" != *"clone into"* ]]
}

@test "the plan says clone into for a fresh target" {
  run env BROKKR_INSTALL_LIB=1 BROKKR_NO_LOG=1 NO_COLOR=1 sh -c '
    . ./install.sh
    TARGET_DIR=/example/boss
    TARGET_STATE=clone
    REPO_URL="$DEFAULT_REPO_URL"
    HOST_OS=macos
    print_plan
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"clone into : /example/boss"* ]]
  [[ "$output" != *"adopt"* ]]
}
