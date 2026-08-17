setup() {
  cd "$BATS_TEST_DIRNAME/../.."
  . devenv/lib/bats-helpers.bash
  TMP=$(mktemp -d)
  mkdir -p "$TMP/home"
  mock_bin virtqemud '
echo "spawned $*" >> "$TMPLOG"
echo $$ > "$TMPMARKER"
exec sleep 3600'
  mock_bin pgrep '
case "$*" in
*irtqemud*"--timeout 0"*)
  [ -f "$TMPMARKER" ] || exit 1
  pid="$(cat "$TMPMARKER")"
  kill -0 "$pid" 2>/dev/null || exit 1
  echo "$pid"
  ;;
*) exit 1 ;;
esac'
  export TMPLOG="$TMP/log" TMPMARKER="$TMP/daemon.pid" HOME="$TMP/home"
}

teardown() {
  if [ -f "$TMP/daemon.pid" ]; then
    kill "$(cat "$TMP/daemon.pid")" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}

@test "wrapper spawns virtqemud --timeout 0 when no daemon is live" {
  bash devenv/lib/virtqemud-wrapper.sh &
  sleep 1
  run grep -c 'spawned --timeout 0' "$TMPLOG"
  [ "$output" = 1 ]
}

@test "wrapper adopts a live daemon without a second spawn" {
  bash devenv/lib/virtqemud-wrapper.sh &
  sleep 1
  bash devenv/lib/virtqemud-wrapper.sh &
  HOLDER=$!
  sleep 1
  run grep -c spawned "$TMPLOG"
  [ "$output" = 1 ]
  kill "$HOLDER" 2>/dev/null || true
}

@test "adopt probe pattern cannot match a sibling wrapper's own pgrep argv" {
  run bash -c 'echo "pgrep -f [v]irtqemud --timeout 0" | grep -E "[v]irtqemud --timeout 0"'
  [ "$status" -eq 1 ]
  run bash -c 'echo "virtqemud --timeout 0" | grep -E "[v]irtqemud --timeout 0"'
  [ "$status" -eq 0 ]
}

@test "wrapper adopts when a daemon appears during the transient wait" {
  mock_bin pgrep '
case "$*" in
*irtqemud*"--timeout 0"*)
  [ -f "$TMPMARKER" ] || exit 1
  pid="$(cat "$TMPMARKER")"
  kill -0 "$pid" 2>/dev/null || exit 1
  echo "$pid"
  ;;
*"--timeout[= ]120"*)
  c=$(cat "$TMP/transient.count" 2>/dev/null || echo 0)
  c=$((c + 1))
  echo "$c" > "$TMP/transient.count"
  if [ "$c" -ge 2 ] && [ ! -f "$TMPMARKER" ]; then
    sleep 30 </dev/null >/dev/null 2>&1 &
    echo $! > "$TMPMARKER"
  fi
  [ -f "$TMPMARKER" ] && exit 1 || exit 0
  ;;
*) exit 1 ;;
esac'
  bash devenv/lib/virtqemud-wrapper.sh &
  HOLDER=$!
  sleep 5
  run bash -c '[ ! -f "$1" ] || ! grep -q spawned "$1"' _ "$TMPLOG"
  [ "$status" -eq 0 ]
  kill "$HOLDER" 2>/dev/null || true
  [ -f "$TMPMARKER" ] && kill "$(cat "$TMPMARKER")" 2>/dev/null || true
}
