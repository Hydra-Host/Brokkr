setup() {
  cd "$BATS_TEST_DIRNAME/../.."
  . devenv/lib/bats-helpers.bash
  SCRIPT="$PWD/apps/local-sim/scripts/tasks/stack-reconcile.sh"
  PROC_HEALTH="$PWD/apps/local-lab/src/services/proc-health.ts"
  export SCRIPT PROC_HEALTH
  export PC_SOCKET_PATH="$BATS_TEST_TMPDIR/pc.sock"
  export PC_STATE="$BATS_TEST_TMPDIR/pc-state.json"
  export PC_TRACE="$BATS_TEST_TMPDIR/pc-trace"
  export PC_STUB="$BATS_TEST_TMPDIR/pc-stub.py"
  export RECONCILE_HEAL_INTERVAL=1
  export RECONCILE_STUCK_ATTEMPTS=3
  export RECONCILE_DEP_TIMEOUT=2
  : >"$PC_TRACE"
  write_stub
  mock_bin process-compose 'exec python3 "$PC_STUB" "$@"'
}

write_stub() {
  cat >"$PC_STUB" <<'STUB'
import json, os, sys, time

state_path = os.environ["PC_STATE"]
trace_path = os.environ["PC_TRACE"]

def load():
    with open(state_path) as fh:
        return json.load(fh)

def save(procs):
    with open(state_path, "w") as fh:
        json.dump(procs, fh)

def log(line):
    with open(trace_path, "a") as fh:
        fh.write(line + "\n")

def apply(rec, key, default_status, default_ready):
    rule = rec.get(key)
    if isinstance(rule, dict):
        rec["status"] = rule.get("status", default_status)
        rec["is_ready"] = rule.get("is_ready", default_ready)
    else:
        rec["status"] = default_status
        rec["is_ready"] = default_ready

toks = []
skip = False
for arg in sys.argv[1:]:
    if skip:
        skip = False
        continue
    if arg == "-U":
        continue
    if arg == "-u":
        skip = True
        continue
    toks.append(arg)

procs = load()
by_name = {p["name"]: p for p in procs}

if toks[:2] == ["process", "list"]:
    now = time.time()
    for rec in procs:
        if rec.get("ripe_at") is not None and now >= rec["ripe_at"]:
            rec["is_ready"] = "Ready"
            rec.pop("ripe_at")
    save(procs)
    print(json.dumps(procs))
    sys.exit(0)

if toks[:2] == ["process", "stop"]:
    name = toks[2]
    log("stop " + name)
    rec = by_name.get(name)
    if rec is None:
        sys.exit(1)
    apply(rec, "on_stop", "Stopped", "-")
    save(procs)
    sys.exit(0)

if toks[:2] == ["process", "start"]:
    name = toks[2]
    log("start " + name)
    rec = by_name.get(name)
    if rec is None:
        sys.exit(1)
    skips = rec.get("skip_starts", 0)
    if skips > 0:
        rec["skip_starts"] = skips - 1
        rec["status"] = "Skipped"
        rec["is_ready"] = "-"
        save(procs)
        sys.exit(0)
    if rec.get("wedges_on_start"):
        for other in procs:
            if name in other.get("depends_on", []) and other.get("status") == "Running":
                other["status"] = "Skipped"
                other["is_ready"] = "-"
                other["cleared"] = False
    source = by_name.get(rec.get("cleared_by"), {})
    dep_ready = rec.get("cleared_by") is None or (
        source.get("status") == "Running" and source.get("is_ready") == "Ready"
    )
    if rec.get("cleared") and dep_ready:
        rec["status"] = "Running"
        rec["is_ready"] = "Ready"
    else:
        apply(rec, "on_start", "Running", "Ready")
    if rec.get("ripens") and rec["status"] == "Running":
        rec["is_ready"] = "-"
        rec["ripe_at"] = time.time() + float(os.environ.get("PC_RIPEN_SECS", "2"))
    for other in procs:
        if other.get("cleared_by") == name:
            other["cleared"] = True
    save(procs)
    sys.exit(0)

if toks[:1] == ["graph"]:
    nodes = {}
    for rec in procs:
        deps = {}
        for dep in rec.get("depends_on", []):
            other = by_name.get(dep, {})
            deps[dep] = {
                "name": dep,
                "process_status": other.get("status", ""),
                "is_ready": other.get("is_ready", ""),
            }
        nodes[rec["name"]] = {"name": rec["name"], "depends_on": deps}
    print(json.dumps({"nodes": nodes}))
    sys.exit(0)

sys.exit(1)
STUB
}

write_state() {
  printf '%s\n' "$1" >"$PC_STATE"
}

healthy() { # <name> <namespace>
  printf '{"name":"%s","namespace":"%s","status":"Running","is_ready":"Ready"}' "$1" "$2"
}

trace_index() { # <line>
  grep -n -x -F "$1" "$PC_TRACE" | head -1 | cut -d: -f1
}

@test "a terminal process is stopped before it is started" {
  write_state "[$(healthy postgres datastore),{\"name\":\"redis\",\"namespace\":\"datastore\",\"status\":\"Completed\",\"is_ready\":\"-\"}]"

  RECONCILE_SCOPE=datastores run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"redis — was Completed; stop → start"* ]]
  [ -n "$(trace_index 'stop redis')" ]
  [ "$(trace_index 'stop redis')" -lt "$(trace_index 'start redis')" ]
}

@test "a healthy process is neither stopped nor started" {
  write_state "[$(healthy postgres datastore),$(healthy redis datastore)]"

  RECONCILE_SCOPE=datastores run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [ ! -s "$PC_TRACE" ]
}

skipped_on_healthy_postgres() {
  printf '{"name":"redis","namespace":"datastore","status":"Skipped","is_ready":"-","depends_on":["postgres"],"cleared_by":"postgres","on_start":{"status":"Skipped","is_ready":"-"},"on_stop":{"status":"Skipped","is_ready":"-"}}'
}

@test "a stuck process is cleared by restarting the dependency it declares, healthy or not" {
  write_state "[$(healthy postgres datastore),$(skipped_on_healthy_postgres)]"

  RECONCILE_SCOPE=datastores run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"restarting its dependency postgres"* ]]
  [ -n "$(trace_index 'stop postgres')" ]
  [ "$(trace_index 'stop postgres')" -lt "$(trace_index 'start postgres')" ]
  [[ "$output" == *"✓ datastores ready"* ]]
}

@test "the dependency restart comes only after the per-process heals have failed" {
  write_state "[$(healthy postgres datastore),$(skipped_on_healthy_postgres)]"

  RECONCILE_SCOPE=datastores run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [ "$(head -n "$(($(trace_index 'stop postgres') - 1))" "$PC_TRACE" | grep -c -x -F 'start redis')" -ge 3 ]
}

@test "give-up names the stuck process and its unmet dependency after three static attempts" {
  stuck='{"name":"redis","namespace":"datastore","status":"Skipped","is_ready":"-","depends_on":["postgres"],"on_start":{"status":"Skipped","is_ready":"-"},"on_stop":{"status":"Skipped","is_ready":"-"}}'
  down='{"name":"postgres","namespace":"datastore","status":"Error","is_ready":"-","on_start":{"status":"Error","is_ready":"-"},"on_stop":{"status":"Error","is_ready":"-"}}'
  write_state "[$down,$stuck]"

  RECONCILE_SCOPE=datastores run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"redis — stuck in Skipped after 3 heal attempts"* ]]
  [[ "$output" == *"waiting on postgres (Error)"* ]]
  [ "$(grep -c -x -F 'start redis' "$PC_TRACE")" -le 8 ]
}

@test "a control-namespace dependency is never restarted to clear a stuck process" {
  stuck='{"name":"hub-web","namespace":"hub","status":"Skipped","is_ready":"-","depends_on":["lab"],"cleared_by":"lab","on_start":{"status":"Skipped","is_ready":"-"},"on_stop":{"status":"Skipped","is_ready":"-"}}'
  write_state "[$(healthy postgres datastore),$(healthy lab control),$stuck]"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"leaving its dependency lab alone"* ]]
  [[ "$output" == *"hub-web — stuck in Skipped"* ]]
  [ -z "$(trace_index 'stop lab')" ]
  [ -z "$(trace_index 'start lab')" ]
}

@test "the escalation waits for the restarted dependency's probe before starting the stuck process" {
  dep='{"name":"hub-admin","namespace":"hub","status":"Running","is_ready":"Ready","has_ready_probe":true,"ripens":true}'
  stuck='{"name":"hub-web-admin","namespace":"hub","status":"Skipped","is_ready":"-","depends_on":["hub-admin"],"cleared_by":"hub-admin","on_start":{"status":"Skipped","is_ready":"-"},"on_stop":{"status":"Skipped","is_ready":"-"}}'
  write_state "[$(healthy postgres datastore),$dep,$stuck]"

  RECONCILE_DEP_TIMEOUT=10 run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"restarting its dependency hub-admin"* ]]
  [[ "$output" != *"hub-web-admin — stuck in Skipped"* ]]
  [[ "$output" == *"✓ hub ready"* ]]
}

@test "dep_ready holds a probe-bearing dependency to its probe where is_up would not" {
  DEP_READY_FN=$(sed -n '/^dep_ready() {/,/^}$/p' "$SCRIPT")
  [ -n "$DEP_READY_FN" ]
  export DEP_READY_FN

  run bash -c 'eval "$DEP_READY_FN"; pstatus() { printf "Running"; }; pready() { printf -- "-"; }; jqf() { printf "true"; }; dep_ready x'
  [ "$status" -eq 1 ]
  run bash -c 'eval "$DEP_READY_FN"; pstatus() { printf "Running"; }; pready() { printf "Ready"; }; jqf() { printf "true"; }; dep_ready x'
  [ "$status" -eq 0 ]
  run bash -c 'eval "$DEP_READY_FN"; pstatus() { printf "Running"; }; pready() { printf -- "-"; }; jqf() { printf ""; }; dep_ready x'
  [ "$status" -eq 0 ]
  run bash -c 'eval "$DEP_READY_FN"; pstatus() { printf "Completed"; }; pready() { printf "Ready"; }; jqf() { printf ""; }; dep_ready x'
  [ "$status" -eq 1 ]
}

@test "is_up keeps the lenient readiness rule proc-health.ts states" {
  IS_UP_FN=$(sed -n '/^is_up() {/,/^}$/p' "$SCRIPT")
  [ -n "$IS_UP_FN" ]
  export IS_UP_FN

  run bash -c 'eval "$IS_UP_FN"; pstatus() { printf "%s" "$1"; }; pready() { printf -- "-"; }; is_up Running'
  [ "$status" -eq 0 ]
  run bash -c 'eval "$IS_UP_FN"; pstatus() { printf "%s" "$1"; }; pready() { printf "Not Ready"; }; is_up Running'
  [ "$status" -eq 1 ]
  run bash -c 'eval "$IS_UP_FN"; pstatus() { printf "%s" "$1"; }; pready() { printf "Ready"; }; is_up Completed'
  [ "$status" -eq 1 ]
}

@test "is_up and procIsUp name each other as the contract they share" {
  run grep -F "stack-reconcile.sh" "$PROC_HEALTH"
  [ "$status" -eq 0 ]
  run grep -F "proc-health.ts" "$SCRIPT"
  [ "$status" -eq 0 ]
  run grep -F "s === 'running' && r !== 'not ready'" "$PROC_HEALTH"
  [ "$status" -eq 0 ]
  run grep -F "procIsDepReady" "$SCRIPT"
  [ "$status" -eq 0 ]
  run grep -F "dep_ready()" "$PROC_HEALTH"
  [ "$status" -eq 0 ]
}

skipped_chain_link() { # <name> <dependency>
  printf '{"name":"%s","namespace":"hub","status":"Skipped","is_ready":"-","depends_on":["%s"],"cleared_by":"%s","on_start":{"status":"Skipped","is_ready":"-"},"on_stop":{"status":"Skipped","is_ready":"-"}}' "$1" "$2" "$2"
}

@test "a three-deep skipped chain clears in one pass, the leaf holding until the middle settles" {
  write_state "[$(healthy redis datastore),$(skipped_chain_link hub-admin hub-api),$(skipped_chain_link hub-web-admin hub-admin),$(skipped_chain_link hub-api redis)]"

  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"✓ hub ready"* ]]
  [[ "$output" != *"stuck in Skipped"* ]]
  [[ "$output" == *"hub-web-admin — holding its heal attempts until hub-admin settles"* ]]
  [ "$(grep -c -x -F 'start hub-web-admin' "$PC_TRACE")" -le 3 ]
}

@test "a dependency that never becomes ready defers the dependent instead of starting it anyway" {
  never_ready='{"name":"postgres","namespace":"datastore","status":"Running","is_ready":"Ready","has_ready_probe":true,"on_start":{"status":"Running","is_ready":"-"},"on_stop":{"status":"Stopped","is_ready":"-"}}'
  write_state "[$never_ready,$(skipped_on_healthy_postgres)]"

  RECONCILE_SCOPE=datastores run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"postgres not ready after 2s; deferring redis"* ]]
  [[ "$output" == *"redis — stuck in Skipped after 3 heal attempts"* ]]
  [ "$(tail -n 1 "$PC_TRACE")" = "start postgres" ]
}

wedged_chain_state() {
  local api admin web_admin
  api='{"name":"hub-api","namespace":"hub","status":"Skipped","is_ready":"-","depends_on":["redis"],"cleared_by":"redis","wedges_on_start":true,"on_start":{"status":"Skipped","is_ready":"-"},"on_stop":{"status":"Skipped","is_ready":"-"}}'
  admin='{"name":"hub-admin","namespace":"hub","status":"Running","is_ready":"Ready","depends_on":["hub-api"],"skip_starts":5}'
  web_admin='{"name":"hub-web-admin","namespace":"hub","status":"Skipped","is_ready":"-","depends_on":["hub-admin"],"cleared_by":"hub-admin","on_start":{"status":"Skipped","is_ready":"-"},"on_stop":{"status":"Skipped","is_ready":"-"}}'
  write_state "[$(healthy redis datastore),$api,$admin,$web_admin]"
}

@test "a process knocked out mid-pass earns a second pass that clears it and the chain behind it" {
  wedged_chain_state

  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"hub-web-admin — stuck in Skipped after 3 heal attempts"* ]]
  [[ "$output" == *"pass 2 — healing this tier knocked out hub-admin; re-healing hub-admin hub-web-admin"* ]]
  [[ "$output" == *"✓ hub ready"* ]]
  [[ "$output" != *"still not ready after reconcile"* ]]
}

@test "a permanently stuck process buys no extra pass and is still reported" {
  never_ready='{"name":"postgres","namespace":"datastore","status":"Running","is_ready":"Ready","has_ready_probe":true,"on_start":{"status":"Running","is_ready":"-"},"on_stop":{"status":"Stopped","is_ready":"-"}}'
  write_state "[$never_ready,$(skipped_on_healthy_postgres)]"

  RECONCILE_SCOPE=datastores run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"redis — stuck in Skipped after 3 heal attempts"* ]]
  [[ "$output" != *"pass 2"* ]]
  [[ "$output" != *"no more heal passes"* ]]
  [[ "$output" == *"still not ready after reconcile: redis"* ]]
  [ "$(grep -c -x -F 'start redis' "$PC_TRACE")" -le 5 ]
}

@test "the pass cap stops the re-passes and names what is still wedged" {
  wedged_chain_state

  RECONCILE_TIER_PASSES=1 run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"no more heal passes (limit 1) — healing it is still knocking out hub-admin"* ]]
  [[ "$output" != *"pass 2"* ]]
  [[ "$output" == *"still not ready after reconcile: hub-admin hub-web-admin"* ]]
}

live_wedge_state() {
  local a b c
  a='{"name":"a","namespace":"hub","status":"Skipped","is_ready":"-","depends_on":["dep"],"cleared_by":"dep","on_start":{"status":"Skipped","is_ready":"-"},"on_stop":{"status":"Skipped","is_ready":"-"}}'
  b='{"name":"b","namespace":"hub","status":"Running","is_ready":"Ready","depends_on":["a"],"skip_starts":2}'
  c='{"name":"c","namespace":"hub","status":"Skipped","is_ready":"-","depends_on":["b"],"cleared_by":"b","on_start":{"status":"Skipped","is_ready":"-"},"on_stop":{"status":"Skipped","is_ready":"-"}}'
  write_state "[$(healthy dep datastore),$a,$b,$c]"
}

@test "a process that gave up earns a pass once the dependency it gave up on comes back" {
  live_wedge_state

  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"[c] restarting its dependency b"* ]]
  [[ "$output" == *"b not ready after 2s; deferring c"* ]]
  [[ "$output" == *"c — stuck in Skipped after 3 heal attempts; waiting on b (Skipped)"* ]]
  [[ "$output" == *"pass 2 — the dependency c gave up on is available again; re-healing c"* ]]
  [[ "$output" == *"✓ hub ready"* ]]
  [[ "$output" != *"still not ready after reconcile"* ]]
}

ripening_wedge_state() {
  local a b c
  a='{"name":"a","namespace":"hub","status":"Skipped","is_ready":"-","depends_on":["dep"],"cleared_by":"dep","on_start":{"status":"Skipped","is_ready":"-"},"on_stop":{"status":"Skipped","is_ready":"-"}}'
  b='{"name":"b","namespace":"hub","status":"Running","is_ready":"Ready","has_ready_probe":true,"ripens":true,"depends_on":["a"],"skip_starts":2}'
  c='{"name":"c","namespace":"hub","status":"Skipped","is_ready":"-","depends_on":["b"],"cleared_by":"b","on_start":{"status":"Skipped","is_ready":"-"},"on_stop":{"status":"Skipped","is_ready":"-"}}'
  write_state "[$(healthy dep datastore),$a,$b,$c]"
}

@test "a dependency that came back Running with its probe still pending earns the pass" {
  ripening_wedge_state

  PC_RIPEN_SECS=6 RECONCILE_DEP_TIMEOUT=8 run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"c — stuck in Skipped after 3 heal attempts"* ]]
  [[ "$output" == *"pass 2 — the dependency c gave up on is available again; re-healing c"* ]]
  [[ "$output" == *"✓ hub ready"* ]]
  [[ "$output" != *"still not ready after reconcile"* ]]
}

@test "a blocking dependency that is not running at all is never waited on" {
  local start elapsed
  stuck='{"name":"hub-web","namespace":"hub","status":"Skipped","is_ready":"-","depends_on":["lab"],"on_start":{"status":"Skipped","is_ready":"-"},"on_stop":{"status":"Skipped","is_ready":"-"}}'
  gone='{"name":"lab","namespace":"control","status":"Completed","is_ready":"-"}'
  freed='{"name":"hub-w","namespace":"hub","status":"Skipped","is_ready":"-","depends_on":["redis"],"cleared_by":"redis","on_start":{"status":"Skipped","is_ready":"-"},"on_stop":{"status":"Skipped","is_ready":"-"}}'
  write_state "[$(healthy redis datastore),$gone,$stuck,$freed]"

  start=$SECONDS
  RECONCILE_DEP_TIMEOUT=60 run bash "$SCRIPT"
  elapsed=$((SECONDS - start))

  [ "$status" -eq 1 ]
  [[ "$output" == *"leaving its dependency lab alone"* ]]
  [[ "$output" == *"still not ready after reconcile: hub-web"* ]]
  [[ "$output" != *"pass 2"* ]]
  [ "$elapsed" -lt 30 ]
}

@test "a process whose blocking dependency never comes back earns no re-pass" {
  otel='{"name":"otel","namespace":"observability","status":"Stopped","is_ready":"-"}'
  thanos='{"name":"thanos","namespace":"observability","status":"Error","is_ready":"-","on_start":{"status":"Error","is_ready":"-"},"on_stop":{"status":"Error","is_ready":"-"}}'
  query='{"name":"thanos-query","namespace":"observability","status":"Skipped","is_ready":"-","depends_on":["thanos"],"on_start":{"status":"Skipped","is_ready":"-"},"on_stop":{"status":"Skipped","is_ready":"-"}}'
  write_state "[$(healthy postgres datastore),$otel,$thanos,$query]"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"thanos-query — stuck in Skipped after 3 heal attempts; waiting on thanos (Error)"* ]]
  [[ "$output" != *"pass 2"* ]]
  [[ "$output" != *"no more heal passes"* ]]
  [[ "$output" == *"still not ready after reconcile: thanos thanos-query"* ]]
}

@test "a dependency cycle falls back to snapshot order and still terminates" {
  alpha='{"name":"alpha","namespace":"datastore","status":"Skipped","is_ready":"-","depends_on":["beta"],"on_start":{"status":"Skipped","is_ready":"-"},"on_stop":{"status":"Skipped","is_ready":"-"}}'
  beta='{"name":"beta","namespace":"datastore","status":"Skipped","is_ready":"-","depends_on":["alpha"],"on_start":{"status":"Skipped","is_ready":"-"},"on_stop":{"status":"Skipped","is_ready":"-"}}'
  write_state "[$(healthy postgres datastore),$alpha,$beta]"

  RECONCILE_SCOPE=datastores run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"alpha — stuck in Skipped"* ]]
  [[ "$output" == *"beta — stuck in Skipped"* ]]
  [[ "$output" != *"holding its heal attempts"* ]]
  [ -n "$(trace_index 'start alpha')" ]
  [ -n "$(trace_index 'start beta')" ]
}

@test "a tier stops at its timeout in seconds even when every heal blocks on a hanging stop" {
  hangs='{"name":"redis","namespace":"datastore","status":"Skipped","is_ready":"-","on_start":{"status":"Skipped","is_ready":"-"},"on_stop":{"status":"Pending","is_ready":"-"}}'
  write_state "[$hangs]"

  RECONCILE_SCOPE=datastores RECONCILE_TIER_TIMEOUT=4 RECONCILE_STOP_WAIT=3 \
    RECONCILE_STUCK_ATTEMPTS=99 RECONCILE_TIER_PASSES=1 run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [ "$(grep -c -x -F 'stop redis' "$PC_TRACE")" -le 2 ]
}

@test "a probe-pending dependency is named as unmet instead of reported as none" {
  local dep stuck
  dep='{"name":"hub-admin","namespace":"hub","status":"Running","is_ready":"-","has_ready_probe":true,"on_start":{"status":"Running","is_ready":"-"},"on_stop":{"status":"Running","is_ready":"-"}}'
  stuck='{"name":"hub-web-admin","namespace":"hub","status":"Skipped","is_ready":"-","depends_on":["hub-admin"],"on_start":{"status":"Skipped","is_ready":"-"},"on_stop":{"status":"Skipped","is_ready":"-"}}'
  write_state "[$dep,$stuck]"

  RECONCILE_DEP_TIMEOUT=1 run bash "$SCRIPT"

  [[ "$output" == *"hub-web-admin — stuck in Skipped"* ]]
  [[ "$output" == *"waiting on hub-admin (Running)"* ]]
  [[ "$output" != *"no unmet dependency"* ]]
}

@test "a dependency that crashes on start is given up on without burning the wait budget" {
  local dep stuck
  dep='{"name":"hub-admin","namespace":"hub","status":"Running","is_ready":"Ready","has_ready_probe":true,"on_start":{"status":"Error","is_ready":"-"},"on_stop":{"status":"Error","is_ready":"-"}}'
  stuck='{"name":"hub-web-admin","namespace":"hub","status":"Skipped","is_ready":"-","depends_on":["hub-admin"],"on_start":{"status":"Skipped","is_ready":"-"},"on_stop":{"status":"Skipped","is_ready":"-"}}'
  write_state "[$dep,$stuck]"

  RECONCILE_DEP_TIMEOUT=25 RECONCILE_TIER_PASSES=1 run bash "$SCRIPT"

  [[ "$output" == *"hub-web-admin — stuck in Skipped"* ]]
  [[ "$output" == *"hub-admin is not coming back (Error); deferring hub-web-admin"* ]]
}
