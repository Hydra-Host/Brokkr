#!/usr/bin/env bash
# Reconcile the supervised process-compose processes to their intended running state — the
# single source of truth for stack self-heal, shared by `task up` (RECONCILE_INCLUDE_CC=1) and
# the control center's "Reconcile" op (which streams this output). Assumes the process-compose
# server is already up; it does NOT cold-start it (that stays `devenv up -d`'s job).
#
# Heals only the long-running supervised services — datastores, hub, spoke, observability, and
# (opt-in) the control center. Never the fleet, fleet plumbing (virtqemud), or the one-shot
# init tasks (migrate / sim:seed / fleet:init): those are matched by neither tier below.
# Leaves Disabled processes (opt-in-off) and
# already-Running ones untouched.
set -u

# Resolve the pc UDS the same way the control center's client does: PC_SOCKET_PATH wins, else
# $DEVENV_RUNTIME/pc.sock. No silent default — an unresolved socket means we're not in the env.
PC_SOCK="${PC_SOCKET_PATH:-${DEVENV_RUNTIME:-}/pc.sock}"
if [ -z "${PC_SOCKET_PATH:-}" ] && [ -z "${DEVENV_RUNTIME:-}" ]; then
  echo "✗ stack-reconcile: no process-compose socket (set PC_SOCKET_PATH, or run inside the devenv shell)" >&2
  exit 2
fi

pc() { process-compose -U -u "$PC_SOCK" "$@"; }

if ! pc process list -o json >/dev/null 2>&1; then
  echo "✗ stack-reconcile: process-compose server unreachable at $PC_SOCK — is the stack up? (task up / devenv up -d)" >&2
  exit 2
fi

INCLUDE_CC="${RECONCILE_INCLUDE_CC:-0}"
# Heal attempts a process gets while its state does not move, and the seconds between them.
STUCK_ATTEMPTS="${RECONCILE_STUCK_ATTEMPTS:-3}"
HEAL_INTERVAL="${RECONCILE_HEAL_INTERVAL:-10}"
# How long a restarted dependency gets to come back before the stuck process is given up on.
DEP_READY_TIMEOUT="${RECONCILE_DEP_TIMEOUT:-60}"
# How long a bounce waits for its stop to reach a terminal state. A process that hangs on stop
# blocks the heal, so this is bounded and wait_tier's own deadline is the outer ceiling.
STOP_WAIT="${RECONCILE_STOP_WAIT:-30}"
# Replaces every tier's own ceiling when set. Unset in normal use — the per-tier values are tuned
# to how long each tier really takes to come up.
TIER_TIMEOUT="${RECONCILE_TIER_TIMEOUT:-}"
# Ceiling on the heal passes one tier gets — see next_pass. Bounds the re-pass against a graph that
# keeps knocking new processes out.
TIER_PASSES="${RECONCILE_TIER_PASSES:-4}"
# Passes one process may earn from the dependency it gave up on becoming available again. Bounds a
# dependency that oscillates from ping-ponging the same process through every remaining pass.
REEARN_LIMIT="${RECONCILE_REEARN_LIMIT:-2}"
# control-plane (default): datastores + hub + spoke. datastores: just the datastore
# tier (the dashboard's "Datastores up" op). CC is added on top of either via RECONCILE_INCLUDE_CC.
SCOPE="${RECONCILE_SCOPE:-control-plane}"
failed=()
SNAP="[]"
TIER_DEPS=()
TIER_WEDGED=""
TIER_RETURNED=""
SEEN=""
BLOCKED=""
REEARNED=""

refresh() { SNAP="$(pc process list -o json 2>/dev/null || echo '[]')"; }

# A field of one process out of the cached snapshot (empty string when absent).
jqf() { printf '%s' "$SNAP" | jq -r --arg n "$1" "(.[]|select(.name==\$n)|$2)//\"\""; }
pstatus() { jqf "$1" '.status'; }
pready() { jqf "$1" '.is_ready'; }

# Process names in the current snapshot belonging to a process-compose namespace, in snapshot order.
# Tiers are keyed on the declared namespace (datastore|hub|spoke|control), not a name allowlist,
# so a process added to devenv with an existing namespace is reconciled with no edit here.
match_ns() { printf '%s' "$SNAP" | jq -r --arg ns "$1" '.[]|select(.namespace==$ns)|.name'; }

# Running and not failing its readiness probe. Lenient on is_ready: a probe-less datastore
# reports "-"/"" yet is usable when Running — only an explicit "Not Ready" keeps us waiting.
# Must stay in lockstep with `procIsUp` in apps/local-lab/src/services/proc-health.ts.
is_up() {
  local s r
  s="$(pstatus "$1")"
  r="$(pready "$1")"
  [ "$s" = "Running" ] && [ "$r" != "Not Ready" ]
}

# A status that means the process has stopped and won't come back on its own — gave up
# (process-compose stops restarting at max_restarts → Completed), crashed terminally, or was
# stopped. These are what we revive. Pending/Launching/Running are in-flight (the DAG or
# process-compose's own on_failure restart owns them) and Disabled is intentional — left alone,
# so running reconcile right after a cold `devenv up -d` never disrupts a still-starting stack.
needs_heal() {
  case "$1" in
  Completed | Error | Stopped | Terminated | Skipped) return 0 ;;
  *) return 1 ;;
  esac
}

# The states a stop settles into. Kept in lockstep with stopAndWait's terminal set in
# apps/local-lab/src/services/process-compose.client.ts.
is_terminal() {
  case "$1" in
  Completed | Error | Stopped | Terminated | Skipped | Disabled | "") return 0 ;;
  *) return 1 ;;
  esac
}

wait_terminal() {
  local n="$1" deadline=$((SECONDS + $2))
  while :; do
    refresh
    is_terminal "$(pstatus "$n")" && return 0
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 1
  done
}

# The daemon's own depends_on map for one process, as JSON — "{}" when the graph is unavailable.
dep_map() {
  local out
  out="$(pc graph -f json 2>/dev/null | jq -c --arg n "$1" '
    [.. | objects | select(.name? == $n) | .depends_on? // empty] | first // {}' 2>/dev/null)"
  [ -n "$out" ] || out='{}'
  printf '%s' "$out"
}

# The dependencies of one process that are not up. Empty when every dependency is ready. Delegates to
# dep_ready so it cannot drift from the gate escalate and next_pass actually use (probe-pending counts).
unmet_deps() {
  local out="" dep
  while IFS= read -r dep; do
    [ -n "$dep" ] || continue
    dep_ready "$dep" && continue
    out="${out:+$out, }$dep ($(pstatus "$dep"))"
  done < <(dep_map "$1" | jq -r 'keys[]' 2>/dev/null)
  printf '%s' "$out"
}

# Every dependency of one process, ready or not.
deps_of() { dep_map "$1" | jq -r 'keys[]' 2>/dev/null; }

# The given processes reordered so none precedes a dependency of its own that is also in the set —
# the shell half of `restartLevels` in apps/local-lab/src/services/redeploy.service.ts. Emits
# "<name>\t<dep,dep>" per process, listing only in-set dependencies. A level that frees nothing is
# a cycle: its members are emitted in the given order with NO dependencies, so an unorderable graph
# degrades to snapshot order instead of deadlocking the callers that gate on that field.
dep_order() {
  local names_json
  names_json="$(printf '%s\n' "$@" | jq -Rsc 'split("\n") | map(select(length > 0))')"
  pc graph -f json 2>/dev/null | jq -r --argjson names "$names_json" '
    (reduce (.. | objects
             | select((.name? | type == "string") and (.depends_on? | type == "object")))
       as $o ({}; .[$o.name] = ($o.depends_on | keys))) as $g
    | {pending: $names, out: []}
    | until(.pending | length == 0;
        .pending as $p
        | [$p[] | . as $x
           | select([($g[$x] // [])[] | select(. as $d | $p | index($d))] | length == 0)] as $free
        | (($free | length) > 0) as $ok
        | (if $ok then $free else $p end) as $level
        | {pending: [$p[] | select(. as $x | $level | index($x) | not)],
           out: (.out + [$level | map({n: ., gated: $ok})])})
    | [.out[][]][]
    | "\(.n)\t\(if .gated then [(($g[.n]) // [])[] | select(. as $d | $names | index($d))] | join(",") else "" end)"
  ' 2>/dev/null
}

report_stuck() {
  local deps
  deps="$(unmet_deps "$1")"
  if [ -n "$deps" ]; then
    echo "  ✗ $1 — stuck in $2 after $STUCK_ATTEMPTS heal attempts; waiting on $deps"
  else
    echo "  ✗ $1 — stuck in $2 after $STUCK_ATTEMPTS heal attempts; no unmet dependency — see its log"
  fi
}

# stop → wait for the terminal state → start. `pc process start` exits 0 on a process it then leaves
# Skipped, so nothing here may be gated on the CLI's exit code — callers re-read the state instead.
bounce() {
  local n="$1" out
  pc process stop "$n" >/dev/null 2>&1 || true
  wait_terminal "$n" "$STOP_WAIT" || echo "    ⚠ $n did not settle after the stop; starting anyway"
  if ! out="$(pc process start "$n" 2>&1)"; then
    echo "    ✗ $n start failed: $(printf '%s' "$out" | tr '\n' ' ')"
  fi
}

heal() {
  local n="$1" s
  s="$(pstatus "$n")"
  if needs_heal "$s"; then
    echo "  ↻ $n — was $s; stop → start"
    bounce "$n"
  elif [ "$s" = "Disabled" ]; then
    echo "  • $n — disabled (left as-is)"
  elif [ -z "$s" ]; then
    echo "  • $n — absent (skipped)"
  else
    echo "  • $n — $s (left as-is)"
  fi
}

# Stricter than is_up, and for one reason: process-compose gates a `process_healthy` dependent on
# health == Ready, and a probe-bearing process reports "-" from its start until its first probe
# lands. Start a dependent in that window and it is Skipped again, which is what made the escalation
# below look unreliable. A probe-less process never reports Ready, so Running is all it can offer.
# Must stay in lockstep with `procIsDepReady` in apps/local-lab/src/services/proc-health.ts.
dep_ready() {
  local r
  [ "$(pstatus "$1")" = "Running" ] || return 1
  r="$(pready "$1")"
  if [ "$(jqf "$1" '.has_ready_probe')" = "true" ]; then
    [ "$r" = "Ready" ]
  else
    [ "$r" != "Not Ready" ]
  fi
}

# Poll until one process can be depended on, or `timeout` seconds elapse. Exit 0 when it is ready,
# 2 when it is not coming back, 1 when the budget ran out — escalate reports the last two differently.
wait_dep_ready() {
  local n="$1" deadline=$((SECONDS + $2)) dead=0
  while :; do
    refresh
    dep_ready "$n" && return 0
    # Skipped is absent deliberately: a dependency transition clears it, which may be what this very
    # reconcile is driving. Twice in a row, because a bounce's start has not landed on the first poll.
    case "$(pstatus "$n")" in
    Error | Completed | Stopped | Terminated) dead=$((dead + 1)) ;;
    *) dead=0 ;;
    esac
    [ "$dead" -ge 2 ] && return 2
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 1
  done
}

# Whether the dependency a process gave up on can be depended on now. One that is Running with its
# probe still pending is on its way up (measured: ~7s from Running to Ready on hub-admin), so it gets
# the same bounded wait the escalation uses. Anything else resolves at once and never spends it.
dep_available() {
  dep_ready "$1" && return 0
  [ "$(pstatus "$1")" = "Running" ] || return 1
  wait_dep_ready "$1" "$DEP_READY_TIMEOUT"
}

# Record what a process was still waiting on when it gave up, but only a dependency that was not
# available then — `dep_ready` on both sides, so "available" means the same at give-up as it does
# when next_pass reads this back. A process that gave up with everything available records nothing.
note_blocked() {
  local n="$1" dep
  while IFS= read -r dep; do
    [ -n "$dep" ] || continue
    dep_ready "$dep" && continue
    BLOCKED="$n:$dep${BLOCKED:+ $BLOCKED}"
    return 0
  done < <(deps_of "$n")
  return 1
}

# The dependency most recently recorded against a process; nonzero when it gave up on none.
blocked_dep() {
  local e
  for e in $BLOCKED; do
    [ "${e%%:*}" = "$1" ] || continue
    printf '%s' "${e#*:}"
    return 0
  done
  return 1
}

earned_passes() {
  local e c=0
  for e in $REEARNED; do [ "$e" = "$1" ] && c=$((c + 1)); done
  printf '%s' "$c"
}

# A process the per-process heals cannot move is waiting on a dependency transition it will never
# see: Skipped is terminal — the daemon refuses to start it and re-evaluates it only when a
# dependency changes state — so the dependency is restarted EVEN WHEN IT IS ALREADY RUNNING AND
# READY. That is disruptive (bouncing redis takes hub-api and the spoke down with it), which is why
# it runs only after the per-process heals have failed. Never a `control` dependency: that namespace
# is the control center this may be running inside.
escalate() {
  local n="$1" dep restarted=0 unready=0 deps=()
  while IFS= read -r dep; do [ -n "$dep" ] && deps+=("$dep"); done < <(deps_of "$n")
  if [ "${#deps[@]}" -eq 0 ]; then
    echo "  ✗ $n — not moving under per-process heals, and it declares no dependency to restart"
    return 1
  fi
  for dep in "${deps[@]}"; do
    if [ "$(jqf "$dep" '.namespace')" = "control" ]; then
      echo "  • $n — leaving its dependency $dep alone: restarting the control center would kill this run"
      continue
    fi
    echo "  ↻ [$n] restarting its dependency $dep — only a dependency transition clears a skipped process"
    bounce "$dep"
    wait_dep_ready "$dep" "$DEP_READY_TIMEOUT"
    case "$?" in
    0) restarted=1 ;;
    2)
      unready=1
      echo "    ⚠ $dep is not coming back ($(pstatus "$dep")); deferring $n — waiting out its ${DEP_READY_TIMEOUT}s budget would change nothing"
      ;;
    *)
      unready=1
      echo "    ⚠ $dep not ready after ${DEP_READY_TIMEOUT}s; deferring $n — starting it now would only skip it again"
      ;;
    esac
  done
  [ "$restarted" -eq 1 ] || return 1
  [ "$unready" -eq 0 ] || return 1
  bounce "$n"
  refresh
  needs_heal "$(pstatus "$n")" && return 1
  return 0
}

# The first of `$1` (a comma-separated list of tier siblings) this pass has not finished with —
# neither up nor abandoned. Reads wait_tier's `names`/`abandoned` arrays through bash's dynamic
# scope, the way the rest of these helpers read the `SNAP` snapshot.
unsettled_dep() {
  local d k
  for d in ${1//,/ }; do
    for ((k = 0; k < ${#names[@]}; k++)); do
      [ "${names[k]}" = "$d" ] || continue
      [ "${abandoned[k]}" -eq 1 ] && break
      is_up "$d" && break
      [ "$(pstatus "$d")" = "Disabled" ] && break
      printf '%s' "$d"
      return 0
    done
  done
  return 1
}

# Poll until every given process is up (or Disabled), or `timeout` seconds elapse; stragglers
# are appended to `failed`.
#
# Terminal states are re-healed mid-wait — notably Skipped: process-compose skips a manual
# `pc process start` whose depends_on wasn't healthy yet (e.g. hub-web vs a still-coming-up
# hub-api), and Skipped never self-recovers. Running-but-not-ready (Vite first-compile) is not
# terminal, so it's left to finish on its own. A process whose state does not move under
# STUCK_ATTEMPTS heals is waiting on something a per-process start cannot fix: it escalates once to
# restarting its own dependency, then it is named and abandoned.
#
# Names arrive in dependency order (see order_tier) and a process holds its attempts while a
# dependency of its own is still being healed by this same pass — a parent that has not recovered
# yet would only skip the child again, and the three-attempt budget would be gone by the time the
# parent came back.
wait_tier() {
  local timeout="$1"
  shift
  [ "$#" -eq 0 ] && return 0
  local names=("$@") i j n s held pending=() last=() tries=() abandoned=() escalated=() tdeps=() noted=()
  local gated=0
  [ "${#TIER_DEPS[@]}" -eq "${#names[@]}" ] && gated=1
  for ((j = 0; j < ${#names[@]}; j++)); do
    last[j]=""
    tries[j]=0
    abandoned[j]=0
    escalated[j]=0
    noted[j]=0
    tdeps[j]=""
    [ "$gated" -eq 1 ] && tdeps[j]="${TIER_DEPS[j]}"
  done
  local waiting
  # A heal blocks while it waits out a stop, so the iteration count alone is not the ceiling the
  # callers pass in seconds — $SECONDS is what makes `timeout` mean seconds.
  local deadline=$((SECONDS + timeout))
  for ((i = 0; i < timeout; i++)); do
    refresh
    pending=()
    waiting=0
    for ((j = 0; j < ${#names[@]}; j++)); do
      n="${names[j]}"
      s="$(pstatus "$n")"
      [ "$s" = "Disabled" ] && continue
      is_up "$n" && continue
      pending+=("$n")
      [ "${abandoned[j]}" -eq 1 ] && continue
      waiting=$((waiting + 1))
      if ! needs_heal "$s"; then
        last[j]="$s"
        tries[j]=0
        continue
      fi
      [ "$i" -gt 0 ] && [ $((i % HEAL_INTERVAL)) -eq 0 ] || continue
      if held="$(unsettled_dep "${tdeps[j]}")"; then
        if [ "${noted[j]}" -eq 0 ]; then
          noted[j]=1
          echo "  • $n — holding its heal attempts until $held settles"
        fi
        continue
      fi
      if [ "${last[j]}" = "$s" ]; then
        tries[j]=$((tries[j] + 1))
      else
        last[j]="$s"
        tries[j]=1
      fi
      if [ "${tries[j]}" -le "$STUCK_ATTEMPTS" ]; then
        heal "$n"
        continue
      fi
      if [ "${escalated[j]}" -eq 0 ]; then
        escalated[j]=1
        if escalate "$n"; then
          last[j]=""
          tries[j]=0
          continue
        fi
      fi
      report_stuck "$n" "$s"
      note_blocked "$n"
      abandoned[j]=1
    done
    [ "${#pending[@]}" -eq 0 ] && return 0
    # every straggler has been abandoned — waiting out the rest of the window changes nothing
    [ "$waiting" -eq 0 ] && break
    [ "$SECONDS" -ge "$deadline" ] && break
    sleep 1
  done
  return 1
}

# Read a namespace's process names into the global `names` array (mapfile-free for portability).
collect() {
  names=()
  local line
  while IFS= read -r line; do [ -n "$line" ] && names+=("$line"); done < <(match_ns "$1")
}

# Reorder the collected `names` so a parent is healed before its children, and record each one's
# in-tier dependencies in `TIER_DEPS` alongside it. Both fall back to snapshot order and no gating
# when the graph cannot be read or cannot be ordered.
order_tier() {
  local nm dl ordered=() deps=()
  TIER_DEPS=()
  [ "${#names[@]}" -gt 1 ] || return 0
  while IFS=$'\t' read -r nm dl; do
    [ -n "$nm" ] || continue
    ordered+=("$nm")
    deps+=("$dl")
  done < <(dep_order "${names[@]}")
  [ "${#ordered[@]}" -eq "${#names[@]}" ] || return 0
  names=("${ordered[@]}")
  TIER_DEPS=("${deps[@]}")
}

# Membership over a space-joined list — the empty list is a plain miss, with none of the `set -u`
# pitfalls an empty array expansion carries.
has_word() {
  case " $2 " in
  *" $1 "*) return 0 ;;
  *) return 1 ;;
  esac
}

# Of the given processes, those a pass still has work on: neither up nor intentionally Disabled.
pending_of() {
  local n
  for n in "$@"; do
    [ "$(pstatus "$n")" = "Disabled" ] && continue
    is_up "$n" && continue
    printf '%s\n' "$n"
  done
}

# Of the given processes, those now in a state only a heal can move.
stuck_now() {
  local n
  for n in "$@"; do needs_heal "$(pstatus "$n")" && printf '%s\n' "$n"; done
}

# The next heal pass over a tier, published as `names`/`TIER_DEPS`/`TIER_WEDGED`/`TIER_RETURNED`;
# nonzero when there is none to run. Two things earn a process another pass, both real transitions:
# it was knocked down by this pass's own healing (the tier order and wait_tier's dependency gate come
# from the snapshot the pass opened with, so a process Running then — restarting redis re-skips
# hub-admin — is in neither and has no attempts left for its children), or it gave up waiting on a
# dependency that has since become available. Everything stuck downstream of the first is re-healed
# with it. Merely still being stuck earns nothing, so a dependency that never comes back never spins.
next_pass() {
  local line nm dl d i hit keep="" stuck=() ordered=() deps=() out=() odeps=()
  while IFS= read -r line; do [ -n "$line" ] && stuck+=("$line"); done < <(stuck_now "$@")
  [ "${#stuck[@]}" -gt 0 ] || return 1
  TIER_WEDGED=""
  TIER_RETURNED=""
  for line in "${stuck[@]}"; do
    if ! has_word "$line" "$SEEN"; then
      keep="$keep $line"
      TIER_WEDGED="${TIER_WEDGED:+$TIER_WEDGED }$line"
      continue
    fi
    d="$(blocked_dep "$line")" || continue
    dep_available "$d" || continue
    [ "$(earned_passes "$line")" -lt "$REEARN_LIMIT" ] || continue
    REEARNED="$REEARNED $line"
    keep="$keep $line"
    TIER_RETURNED="${TIER_RETURNED:+$TIER_RETURNED }$line"
  done
  [ -n "$TIER_WEDGED$TIER_RETURNED" ] || return 1
  while IFS=$'\t' read -r nm dl; do
    [ -n "$nm" ] || continue
    ordered+=("$nm")
    deps+=("$dl")
  done < <(dep_order "${stuck[@]}")
  if [ "${#ordered[@]}" -ne "${#stuck[@]}" ]; then
    ordered=("${stuck[@]}")
    deps=()
  fi
  for ((i = 0; i < ${#ordered[@]}; i++)); do
    nm="${ordered[i]}"
    dl=""
    [ "${#deps[@]}" -eq "${#ordered[@]}" ] && dl="${deps[i]}"
    if ! has_word "$nm" "$keep"; then
      hit=0
      for d in ${dl//,/ }; do
        has_word "$d" "$keep" && hit=1 && break
      done
      [ "$hit" -eq 1 ] || continue
      keep="$keep $nm"
    fi
    out+=("$nm")
    odeps+=("$dl")
  done
  names=("${out[@]}")
  TIER_DEPS=()
  [ "${#deps[@]}" -eq "${#ordered[@]}" ] && TIER_DEPS=("${odeps[@]}")
  return 0
}

pass_reason() {
  local r=""
  [ -n "$TIER_WEDGED" ] && r="healing this tier knocked out $TIER_WEDGED"
  [ -n "$TIER_RETURNED" ] && r="${r:+$r; }the dependency $TIER_RETURNED gave up on is available again"
  printf '%s' "$r"
}

# Generic tier: heal every process in a namespace, wait for the tier to settle, then re-heal whatever
# that healing knocked out or unblocked (next_pass) until the tier settles, a pass frees nothing, or
# TIER_PASSES is reached.
reconcile_tier() {
  local label="$1" ns="$2" timeout="${TIER_TIMEOUT:-$3}" n line pass=1 freed before tier=() left=()
  refresh
  collect "$ns"
  if [ "${#names[@]}" -eq 0 ]; then
    echo "[$label] (none present)"
    return
  fi
  order_tier
  echo "[$label] ${names[*]}"
  tier=("${names[@]}")
  SEEN=""
  BLOCKED=""
  REEARNED=""
  while :; do
    before=""
    while IFS= read -r line; do before="${before:+$before }$line"; done < <(pending_of "${names[@]}")
    for line in $before; do has_word "$line" "$SEEN" || SEEN="$SEEN $line"; done
    for n in "${names[@]}"; do heal "$n"; done
    wait_tier "$timeout" "${names[@]}"
    refresh
    freed=0
    for line in $before; do
      is_up "$line" && freed=1 && break
    done
    [ "$freed" -eq 1 ] || break
    next_pass "${tier[@]}" || break
    if [ "$pass" -ge "$TIER_PASSES" ]; then
      if [ -n "$TIER_WEDGED" ]; then
        echo "  ⚠ [$label] no more heal passes (limit $TIER_PASSES) — healing it is still knocking out $TIER_WEDGED"
      else
        echo "  ⚠ [$label] no more heal passes (limit $TIER_PASSES) — $TIER_RETURNED keeps losing the dependency it waits on"
      fi
      break
    fi
    pass=$((pass + 1))
    echo "  ↻ [$label] pass $pass — $(pass_reason); re-healing ${names[*]}"
  done
  while IFS= read -r line; do [ -n "$line" ] && left+=("$line"); done < <(pending_of "${tier[@]}")
  if [ "${#left[@]}" -eq 0 ]; then
    echo "  ✓ $label ready"
  else
    echo "  ⚠ $label not all ready after ${timeout}s"
    failed+=("${left[@]}")
  fi
}

echo "── stack-reconcile ──  socket: $PC_SOCK  include-cc: $INCLUDE_CC"

# Sanity: the tiers below select by the process-compose `namespace` field (set per process in devenv).
# If processes exist but none carry a datastore/hub/spoke namespace, every tier would silently heal
# nothing — fail loudly instead (e.g. a process-compose upgrade renamed/dropped the field).
refresh
if [ "$(printf '%s' "$SNAP" | jq -r 'length')" -gt 0 ] && [ -z "$(match_ns datastore)$(match_ns hub)$(match_ns spoke)" ]; then
  echo "✗ stack-reconcile: processes exist but none carry a datastore/hub/spoke namespace — cannot tier by namespace (process-compose 'namespace' field changed?)" >&2
  exit 2
fi

# Tier 0: datastores (process-compose namespace=datastore).
reconcile_tier "datastores" datastore 60

# Tier 1+: hub, then spokes, by namespace. Starts are issued for the whole tier at once;
# a manual `pc process start hub-web` whose depends_on (hub-api healthy) isn't satisfied is Skipped
# immediately — it's wait_tier's Skipped-reheal that brings hub-web up once hub-api is ready, NOT
# depends_on (which only orders the initial `up` DAG, not manual starts). The hub window is generous
# (180s) to cover hub-api becoming healthy + hub-web's cold Vite compile in the one combined tier.
# Skipped entirely for the datastores-only scope.
if [ "$SCOPE" != "datastores" ]; then
  # Observability sink (telemetry.enable) BEFORE the hub: hub-api starts exporting OTLP
  # on boot, so the collector should already be listening (exports are fail-soft, but
  # sink-first avoids a burst of dropped spans + retry noise). "(none present)" no-op
  # when absent/Disabled.
  reconcile_tier "observability" observability 60
  reconcile_tier "hub" hub 180
  reconcile_tier "spoke" spoke 90
fi

# The control center itself (namespace=control: lab/lab-web) — only for `task up`. The dashboard
# never sets this: restarting lab/lab-web would kill the cockpit mid-request.
if [ "$INCLUDE_CC" = "1" ]; then
  reconcile_tier "control-center" control 60
fi

echo ""
if [ "${#failed[@]}" -eq 0 ]; then
  echo "✓ stack-reconcile — all supervised processes reconciled and ready."
  exit 0
fi
echo "⚠ stack-reconcile — still not ready after reconcile: ${failed[*]}"
echo "  inspect with: process-compose attach -U   (or the control center logs for that process)"
exit 1
