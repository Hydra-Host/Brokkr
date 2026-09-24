setup() {
  cd "$BATS_TEST_DIRNAME/../.."
  . devenv/lib/bats-helpers.bash
  TMP=$(mktemp -d)
  OWN="$TMP/own"
  SIB="$TMP/sib"
  export DEVENV_ROOT="$OWN"
  export DEVENV_STATE="$TMP/state"
  mkdir -p "$DEVENV_STATE" "$OWN/devenv"
  cp devenv/env-pin-aliases.txt "$OWN/devenv/env-pin-aliases.txt"

  REDIS=/nix/store/aaaaaaaa-redis-7.2.11/bin/redis-server
  PG=/nix/store/bbbbbbbb-postgresql-16.10/bin/postgres
  PC=/nix/store/cccccccc-process-compose-1.64.1/bin/process-compose
  FOREIGN=/opt/homebrew/opt/postgresql@16/bin/postgres
  cat >"$TMP/proctable" <<EOF
999101|$PG|999900|$PG -D $OWN/.devenv/state/postgres|$OWN/.devenv/state/postgres
999102|$PG|1|$PG -D $OWN/.devenv/state/postgres|$OWN/.devenv/state/postgres
999103|$PG|999900|$PG -D $SIB/.devenv/state/postgres|$SIB/.devenv/state/postgres
999104|$REDIS|1|$REDIS 127.0.0.1:6379|$OWN/.devenv/state/redis
999105|$FOREIGN|1|$FOREIGN -D /opt/homebrew/var/postgresql@16|/opt/homebrew/var
999900|$PC|1|$PC -f process-compose.yaml|$OWN
EOF
  proc_table "$TMP/proctable"

  cat >"$TMP/lsof" <<'STUB'
#!/usr/bin/env bash
case "$*" in
*-iTCP:*)
  port=$(printf '%s' "$*" | sed -n 's/.*-iTCP:\([0-9][0-9]*\).*/\1/p')
  for kv in ${PORTMAP:-}; do
    [ "${kv%%=*}" = "$port" ] || continue
    printf '%s\n' "${kv#*=}"
    exit 0
  done
  exit 1
  ;;
*-d*cwd*)
  awk -F'|' -v pid="$3" '$1 == pid && $5 != "" { print "p" $1; print "n" $5; hit = 1 } END { exit hit ? 0 : 1 }' "$PROCTABLE"
  ;;
*) exit 1 ;;
esac
STUB
  chmod +x "$TMP/lsof"
  export REAP_LSOF="$TMP/lsof"
  export PORTMAP=""
  HELD_PID=""
}

teardown() {
  [ -z "$HELD_PID" ] || kill "$HELD_PID" 2>/dev/null || true
  rm -rf "$TMP"
}

free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}

port_is_free() { # <port>
  python3 -c '
import socket, sys
s = socket.socket()
try:
    s.bind(("0.0.0.0", int(sys.argv[1])))
except OSError:
    sys.exit(1)
finally:
    s.close()
' "$1"
}

hold_port() { # <port>
  python3 -c '
import socket, sys, time
s = socket.socket(); s.bind(("0.0.0.0", int(sys.argv[1]))); s.listen(1)
sys.stderr.write("up\n"); sys.stderr.flush()
time.sleep(120)
' "$1" 2>"$TMP/held.$1" &
  HELD_PID=$!
  await 10 test -s "$TMP/held.$1"
}

guard() { # <slot> <spec>...
  run bash devenv/lib/port-guard.sh "$@"
}

@test "a free port passes" {
  port=$(free_port)
  guard 0 "postgres:$port"
  [ "$status" -eq 0 ]
  [[ "$output" == *"port $port (postgres) is free"* ]]
}

@test "a foreign holder blocks and names the port, role, slot, pid and command" {
  port=$(free_port)
  hold_port "$port"
  export PORTMAP="$port=999105"
  guard 7 "postgres:$port"
  [ "$status" -eq 1 ]
  [[ "$output" == *"port $port (postgres, stack slot 7)"* ]]
  [[ "$output" == *"PID 999105"* ]]
  [[ "$output" == *"/opt/homebrew/opt/postgresql@16/bin/postgres"* ]]
  [[ "$output" == *"brew services list"* ]]
  [[ "$output" == *"devenv.local.nix"* ]]
  [[ "$output" == *"BROKKR_PIN_PG_PORT="* ]]
  [[ "$output" == *"Do not use it here"* ]]
}

@test "a foreign holder on the redis port offers the redis pin and knob" {
  port=$(free_port)
  hold_port "$port"
  export PORTMAP="$port=999105"
  guard 0 "redis:$port"
  [ "$status" -eq 1 ]
  [[ "$output" == *"BROKKR_PIN_REDIS_PORT="* ]]
  [[ "$output" == *"ports.redis ="* ]]
  [[ "$output" != *"ports.postgres ="* ]]
}

@test "this stack's own supervised datastore is not a conflict" {
  port=$(free_port)
  hold_port "$port"
  export PORTMAP="$port=999101"
  guard 0 "postgres:$port"
  [ "$status" -eq 0 ]
  [[ "$output" == *"held by this stack (PID 999101)"* ]]
  [[ "$output" != *"✗"* ]]
}

@test "an unsupervised datastore of this checkout is reaped, not reported as foreign" {
  port=$(free_port)
  hold_port "$port"
  export PORTMAP="$port=999102"
  guard 0 "postgres:$port"
  [ "$status" -eq 1 ]
  [[ "$output" == *"unsupervised datastore of this checkout (PID 999102)"* ]]
  [[ "$output" == *"orphaned devenv datastore"* ]]
  [[ "$output" != *"is held by another program"* ]]
}

@test "a sibling checkout's supervised datastore is foreign" {
  port=$(free_port)
  hold_port "$port"
  export PORTMAP="$port=999103"
  guard 0 "postgres:$port"
  [ "$status" -eq 1 ]
  [[ "$output" == *"is held by another program"* ]]
  [[ "$output" == *"PID 999103"* ]]
}

@test "an occupied port with no visible owner still blocks" {
  port=$(free_port)
  hold_port "$port"
  export PORTMAP=""
  guard 0 "postgres:$port"
  [ "$status" -eq 1 ]
  [[ "$output" == *"the owner is not visible to this user"* ]]
  [[ "$output" == *"sudo lsof -nP -iTCP:$port"* ]]
}

@test "the same port passes once the holder releases it" {
  port=$(free_port)
  hold_port "$port"
  guard 0 "postgres:$port"
  [ "$status" -eq 1 ]
  kill "$HELD_PID" 2>/dev/null || true
  HELD_PID=""
  await 10 port_is_free "$port"
  guard 0 "postgres:$port"
  [ "$status" -eq 0 ]
  [[ "$output" == *"is free"* ]]
}

@test "two conflicting datastores are offered different replacement ports" {
  pg=$(free_port)
  hold_port "$pg"
  pgpid=$HELD_PID
  rd=$(free_port)
  hold_port "$rd"
  export PORTMAP="$pg=999105 $rd=999105"
  guard 0 "postgres:$pg" "redis:$rd"
  kill "$pgpid" 2>/dev/null || true
  [ "$status" -eq 1 ]
  suggested=$(printf '%s\n' "$output" | sed -n 's/.*ports\.[a-z]* = \([0-9][0-9]*\);.*/\1/p' | sort -u | wc -l)
  [ "$suggested" -eq 2 ]
}

@test "a replacement port is never suggested from a stack slot's own block" {
  port=$(free_port)
  hold_port "$port"
  export PORTMAP="$port=999105"
  guard 0 "postgres:$port"
  [ "$status" -eq 1 ]
  suggested=$(printf '%s\n' "$output" | sed -n 's/.*ports\.postgres = \([0-9][0-9]*\);.*/\1/p' | head -n 1)
  [ "$suggested" -ge 43500 ]
  [ "$suggested" -lt 49152 ]
}

@test "the slot remedy migrates when this checkout already came up" {
  port=$(free_port)
  hold_port "$port"
  export PORTMAP="$port=999105"
  printf '0' >"$DEVENV_STATE/stack-slot-applied"
  guard 0 "postgres:$port"
  [ "$status" -eq 1 ]
  [[ "$output" == *"task stack:reslot"* ]]
}

@test "the slot remedy is a plain pin when no bring-up ever completed" {
  port=$(free_port)
  hold_port "$port"
  export PORTMAP="$port=999105"
  guard 2 "postgres:$port"
  [ "$status" -eq 1 ]
  [[ "$output" == *"stack.slot = 3"* ]]
  [[ "$output" != *"task stack:reslot"* ]]
}

@test "a malformed spec is reported and does not block" {
  guard 0 "postgres:notaport"
  [ "$status" -eq 0 ]
  [[ "$output" == *"malformed spec"* ]]
}

@test "the guard refuses to run outside the devenv shell" {
  run env -u DEVENV_ROOT bash devenv/lib/port-guard.sh 0 postgres:5432
  [ "$status" -ne 0 ]
  [[ "$output" == *"DEVENV_ROOT"* ]]
}
