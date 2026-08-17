setup() {
  cd "$BATS_TEST_DIRNAME/../.."
  . devenv/lib/bats-helpers.bash
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
