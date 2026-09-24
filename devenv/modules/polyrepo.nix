{
  pkgs,
  lib,
  config,
  ...
}:

# SSOT for the brokkr-app monorepo checkout (hub + bridge + agent in one tree).
# devenv.nix derives HUB_REPO_PATH from config.polyrepo.hub.path. Override per-host in
# devenv.local.nix (config.polyrepo.hub.path) or via HUB_REPO_PATH in .env/.envrc.local.
#
# Three devenv tasks (namespaced setup:* — devenv requires namespace:name). Run them via the
# Taskfile verbs (task up runs the gate; task doctor / task setup) or `devenv tasks run setup:<x>`:
#   setup:preflight — hard gate `task up` runs first: the sibling checkouts must exist (exit 1 otherwise).
#   setup:doctor    — read-only onboarding report: preflight checks + advisory warnings (ssh key,
#                     plus host-access-check.sh: group membership, libvirt, docker, buildx, KVM).
#   setup:onboard   — opt-in, idempotent: clone any MISSING sibling + create the SSH key if absent.

let
  P = (import ./ports.nix).fromConfig config; # effective port/route map (honors config.ports overrides)

  # Nix-pinned lsof so the squatter check can't silently no-op on a host that lacks it
  # (pkgs.lsof is not on the devenv PATH). Matches the store-path-interpolation convention
  # used for thanos/qemu/secretspec in devenv.nix. `ps` stays the system binary — it's
  # universally present and pkgs.procps is Linux-only (would break the darwin path).
  lsofBin = "${pkgs.lsof}/bin/lsof";

  # App ports a stale `pnpm start:prod` / dist/main can squat. The orphan-EADDRINUSE crash
  # always lands on the primary/base ports — scaled hub replicas (base + step*i) and extra
  # zone spokes only exist while the supervised stack runs, so they're not the orphan class.
  # Every number comes from P.ports.* — change a port in ports.nix and this list follows.
  # The admin entries follow the processes in modules/hub.nix: where the proprietary apps are
  # absent nothing owns those ports, so a listener there is somebody else's and not our squatter.
  squatterPortSpecs = [
    "hub:${toString P.ports.hubApi.base}"
    "spoke:${toString P.ports.spoke.base}"
    "lab:${toString P.ports.lab}"
    "hub-web:${toString P.ports.hubWeb}"
  ]
  ++ lib.optional (builtins.pathExists ../../apps/admin-api) "hub-admin:${toString P.ports.hubAdmin.base}"
  ++ lib.optional (builtins.pathExists ../../apps/admin-web) "hub-web-admin:${toString P.ports.hubWebAdmin}";

  # The two ports devenv RESERVES while it evaluates `devenv up` — its services.{postgres,redis}
  # modules declare processes.<n>.ports.main.allocate and devenv.yaml sets strict_ports, so a
  # foreign listener here aborts the evaluation before any process starts. That is why these block
  # where squatterPortSpecs only warns: nothing downstream can report a fault that stops the eval.
  # config.ports.*, NOT P.ports.* — the latter resolves through ports.nix `allocated` to the
  # allocator's own output, which is the post-shift port rather than the one we intend to bind.
  datastorePortSpecs = [
    "postgres:${toString config.ports.postgres}"
    "redis:${toString config.ports.redis}"
  ];

  # Shared by preflight (BROKK_PREFLIGHT_GATE=1 → hard checks only, exit 1 on failure) and doctor
  # (full report). `expand` resolves a leading ~ / $HOME the same way modules/lib.nix cdRepo does
  # (dotenv stores HUB_REPO_PATH verbatim). No `set -e`: the report runs every check.
  checkScript = ''
    set -u
    expand() { local v="$1"; v="''${v/#\~/$HOME}"; v="''${v/#\$HOME/$HOME}"; printf '%s' "$v"; }
    gate="''${BROKK_PREFLIGHT_GATE:-}"
    fail=0; warned=0; stale=0

    check_repo() {
      local label="$1" var="$2" raw="$3" p
      if [ -z "$raw" ]; then
        echo "✗ $var is unset"
        echo "    set config.polyrepo.$label.path in devenv.local.nix, export $var in .env/.envrc.local, or run: task setup"
        fail=$((fail+1)); return
      fi
      p="$(expand "$raw")"
      if [ ! -d "$p" ]; then
        echo "✗ $var=$raw is not a directory"
        echo "    clone it with: task setup   (or fix the path)"
        fail=$((fail+1)); return
      fi
      echo "✓ $label checkout: $p"
    }
    check_repo hub HUB_REPO_PATH "''${HUB_REPO_PATH:-}"

    # SIGTERM is caught + hung by a wedged NestJS prod build's shutdown hook, so a plain
    # `kill` can report success while the process lives on — escalate to SIGKILL + verify.
    reap_process() {
      local pid="$1" desc="$2"
      kill "$pid" 2>/dev/null
      for _ in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
      if kill -0 "$pid" 2>/dev/null; then
        echo "⚠ $desc survived SIGKILL — still alive"
        warned=$((warned+1))
      else
        echo "✓ reaped $desc"
      fi
    }

    # orphaned `pnpm start:prod` / dist/main processes survive `task down` (reparented to PID 1)
    # and squat the app ports — the devenv hub then dies on EADDRINUSE and the spoke 404s every
    # initrd fetch. Catch the squatter here with the offending PID, not 8 min later at fleet:init.
    # Port list comes from ports.nix via the squatterPortSpecs splice — no literals here.
    check_port_squatters() {
      local label port pid ppid cmd started
      for spec in ${lib.concatStringsSep " " squatterPortSpecs}; do
        label="''${spec%%:*}"; port="''${spec##*:}"
        pid="$(${lsofBin} -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)"
        [ -z "$pid" ] && continue
        ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
        cmd="$(ps -o command= -p "$pid" 2>/dev/null)"
        started="$(ps -o lstart= -p "$pid" 2>/dev/null)"
        # the exact orphan signature: a detached (PPID 1) prod build of the hub/spoke
        if [ "$ppid" = "1" ] && printf '%s' "$cmd" | grep -qE 'apps/(api|bridge)/dist/main'; then
          # unambiguously brokkr-owned — auto-reap by default so a leftover from a prior session
          # never blocks `task up`. BROKK_NO_REAP=1 opts out (report + block, to inspect it first).
          if [ "''${BROKK_NO_REAP:-}" = "1" ]; then
            echo "✗ port $port held by orphaned $label (PID $pid, started $started)"
            echo "    $cmd"
            echo "    reap it:  pkill -f 'apps/api/dist/main'   (or unset BROKK_NO_REAP to auto-reap)"
            fail=$((fail+1))
          else
            reap_process "$pid" "orphaned $label (PID $pid) on :$port"
          fi
        else
          # a foreign listener we won't auto-kill — advise, don't block as a stale orphan
          echo "⚠ port $port ($label) already in use by PID $pid — $cmd"
          echo "    if this isn't a deliberate service, stop it before 'task up'."
          warned=$((warned+1))
        fi
      done
    }

    # a bridge that completed its drain but never exited holds no listening socket, so the port
    # scan above cannot see it — yet it still holds Redis connections in the zone (leader-key
    # contention, stale BullMQ consumption). Match on parentage + command instead of a port.
    # Unlike the port pass (whose port list is already slot-scoped), nothing here confines the
    # match to this stack, so scope it by checkout: the spoke execs a RELATIVE
    # `apps/bridge/dist/main.js` after cd'ing to $HUB_REPO_PATH, so cwd — not the command line —
    # is what tells this checkout's orphan apart from a sibling's. No checkout, no reaping.
    check_portless_orphans() {
      local pid ppid cmd started cwd repo
      repo="$(expand "''${HUB_REPO_PATH:-}")"
      [ -n "$repo" ] || return 0
      repo="$(cd "$repo" 2>/dev/null && pwd -P)"
      [ -n "$repo" ] || return 0
      # process substitution, not a pipe: the loop must run in this shell to keep fail/warned.
      while read -r pid ppid cmd; do
        [ -z "$pid" ] && continue
        [ "$ppid" = "1" ] || continue
        # already reported (and possibly reaped) by the port pass
        ${lsofBin} -nP -p "$pid" -a -iTCP -sTCP:LISTEN -t >/dev/null 2>&1 && continue
        # macOS has no /proc — lsof's cwd fd is the portable read
        cwd="$(${lsofBin} -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
        if [ "$cwd" != "$repo" ] && ! printf '%s' "$cmd" | grep -qF "$repo/apps/bridge/dist/main"; then
          continue
        fi
        started="$(ps -o lstart= -p "$pid" 2>/dev/null)"
        if [ "''${BROKK_NO_REAP:-}" = "1" ]; then
          echo "✗ orphaned spoke with no listening port (PID $pid, started $started)"
          echo "    $cmd"
          echo "    reap it:  kill -9 $pid   (or unset BROKK_NO_REAP to auto-reap)"
          fail=$((fail+1))
        else
          reap_process "$pid" "orphaned spoke (PID $pid, no listening port)"
        fi
      done < <(ps -A -o pid=,ppid=,command= 2>/dev/null | grep -E 'apps/bridge/dist/main' | grep -v grep)
    }

    # multi-stack: each registered slot's data plane is 192.168.(200+S).0/24 — warn when the
    # host already routes one of those subnets elsewhere (a squatting VPN/LAN would blackhole
    # that fleet's data plane). advisory only, never part of the preflight gate.
    check_subnet_overlaps() {
      local registry s slots routes
      registry="''${XDG_STATE_HOME:-$HOME/.local/state}/brokkr-local/stacks"
      [ -d "$registry" ] || return 0
      slots=""
      for f in "$registry"/stack-*.json; do
        [ -e "$f" ] || continue
        s="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["slot"])' "$f" 2>/dev/null || true)"
        [ -z "$s" ] && continue
        case "$s" in *[!0-9]*) continue ;; esac
        sock="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pcSock", ""))' "$f" 2>/dev/null || true)"
        # a live stack legitimately owns its own data-plane route — only a route with NO
        # live owner is a squatter
        if [ -n "$sock" ] && [ -S "$sock" ] && process-compose -U -u "$sock" process list -o json >/dev/null 2>&1; then
          continue
        fi
        slots="$slots $s"
      done
      [ -n "$slots" ] || return 0
      routes="$( (netstat -rn -f inet 2>/dev/null || ip route 2>/dev/null) | grep -E '^192\.168\.' || true)"
      [ -n "$routes" ] || return 0
      for s in $slots; do
        if printf '%s\n' "$routes" | grep -qE "^192\.168\.$((200 + s))([./ ]|$)"; then
          echo "⚠ slot $s data plane 192.168.$((200 + s)).0/24 overlaps an existing host route:"
          printf '%s\n' "$routes" | grep -E "^192\.168\.$((200 + s))([./ ]|$)" | sed 's/^/    /'
          echo "    another network owns that subnet — this slot's fleet data plane would be unreachable."
          warned=$((warned+1))
        fi
      done
    }

    # The blocking half of the port story (squatterPortSpecs is the advisory half). `|| rc=$?`
    # because `devenv tasks run` execs this under errexit, where a bare non-zero exit would abort
    # the script and take the whole verdict down with it — same reason as the host-check call below.
    check_datastore_ports() {
      local rc=0
      REAP_LSOF="${lsofBin}" \
        bash "${config.devenv.root}/devenv/lib/port-guard.sh" \
        ${toString config.stack.slot} ${lib.concatStringsSep " " datastorePortSpecs} || rc=$?
      [ "$rc" = 0 ] || fail=$((fail + 1))
    }

    if [ -n "$gate" ]; then
      check_datastore_ports
      check_port_squatters
      check_portless_orphans
      if [ "$fail" != 0 ]; then
        echo ""
        echo "✗ preflight: fix the above, then re-run 'task up' (or 'task doctor' for the full check)."
        exit 1
      fi
      exit 0
    fi
    check_datastore_ports
    check_port_squatters   # also surface squatters in the full `task doctor` report
    check_portless_orphans
    check_subnet_overlaps

    key="$(expand "''${BRIDGE_SSH_PRIVKEY_PATH:-$HOME/.ssh/id_ed25519}")"
    if [ -f "$key" ]; then
      echo "✓ ssh key: $key"
    else
      echo "⚠ ssh key $key missing — discovery SSH into brokkr-live VMs will hang (wait_for_brokkr_live)."
      echo "    create one with: task setup"
      warned=$((warned+1))
    fi
    # the single host-readiness authority, shared with the bring-up (stack-up runs it without
    # --report, where a blocker gates instead of scoring). 1 = blocking, 2 = advisory only.
    # 78 = a re-login is owed. `|| hostrc=$?` because `devenv tasks run` execs this under errexit,
    # where a blocking check aborted the script and took this whole verdict down with it.
    hostrc=0
    BROKK_FLEET_AUTOSTART=${lib.boolToString config.fleet.autoStart} \
      bash "${config.devenv.root}/devenv/scripts/host-access-check.sh" --report || hostrc=$?
    case $hostrc in
    1) fail=$((fail+1)) ;;
    2) warned=$((warned+1)) ;;
    78) stale=1 ;;
    esac
    echo ""
    if [ "$fail" != 0 ]; then
      echo "✗ doctor: blocking issue(s) above — 'task up' will not proceed until fixed."
      exit 1
    elif [ "$stale" != 0 ]; then
      # 78 is install.sh's RC_GROUPS_STALE, which reads it as a checkpoint and stops without failing
      echo "· doctor: nothing is broken — log out and back in (or reboot), then re-run 'task up'."
      exit 78
    elif [ "$warned" != 0 ]; then
      echo "⚠ doctor: advisory warning(s) above — 'task up' will still run."
    else
      echo "✓ doctor: all checks passed."
    fi
  '';
in
{
  options.polyrepo = {
    hub = {
      path = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "Where the brokkr-app monorepo checkout lives — empty means this repo (devenv.nix resolves it to config.devenv.root). Override in devenv.local.nix or via HUB_REPO_PATH in .env/.envrc.local for a polyrepo layout.";
      };
      url = lib.mkOption {
        type = lib.types.str;
        default = "git@example.com:your-org/brokkr-app.git";
        description = "Clone URL `task setup` uses when the checkout is missing.";
      };
    };
  };

  # the report body on PATH: `task doctor` invokes the script directly (the oneshot task
  # runner swallows stdout), while setup:doctor stays the devenv-task name and delegates to it.
  # Read-only in the catalog: pointing the stack at another checkout needs that checkout to exist,
  # and stackDefaults.hub.HUB_REPO_PATH is a second source of truth for the same thing.
  config.knobMeta = {
    "polyrepo.hub.path" = {
      label = "Hub checkout path";
      group = "Location";
      editable = false;
    };
    "polyrepo.hub.url" = {
      label = "Hub clone URL";
      group = "Location";
      editable = false;
    };
  };

  config.scripts.stack-doctor = {
    description = "Read-only host-readiness report: monorepo checkout, port squatters, SSH key, group membership, libvirt, docker, buildx, KVM.";
    exec = checkScript;
  };

  config.tasks = {
    "setup:preflight" = {
      description = "Hard gate `task up` runs first: the brokkr-app monorepo checkout must exist. Exits non-zero with a fix hint otherwise.";
      exec = ''
        export BROKK_PREFLIGHT_GATE=1
        ${checkScript}
      '';
    };

    "setup:doctor" = {
      description = "Read-only onboarding report: monorepo checkout (blocking) + SSH key, group-membership, libvirt, docker, buildx and KVM advisories. Run anytime: task doctor.";
      exec = "stack-doctor";
    };

    "setup:onboard" = {
      description = "Opt-in, idempotent onboarding: clone the brokkr-app monorepo if MISSING + create the SSH key if absent. Never overwrites. Run once after bootstrap: task setup.";
      exec = ''
        set -u
        expand() { local v="$1"; v="''${v/#\~/$HOME}"; v="''${v/#\$HOME/$HOME}"; printf '%s' "$v"; }
        clone_if_missing() {
          local label="$1" raw="$2" url="$3" p
          if [ -z "$raw" ] || [ -z "$url" ]; then echo "⚠ $label: path or url unset; skipping"; return; fi
          p="$(expand "$raw")"
          if [ -d "$p" ]; then echo "✓ $label already present: $p"; return; fi
          echo "→ cloning $label: $url → $p"
          mkdir -p "$(dirname "$p")"
          if git clone "$url" "$p"; then echo "✓ cloned $label"; else echo "✗ clone of $label failed — clone it into $p yourself"; fi
        }
        clone_if_missing hub "''${HUB_REPO_PATH:-}" "${config.polyrepo.hub.url}"

        key="$(expand "''${BRIDGE_SSH_PRIVKEY_PATH:-$HOME/.ssh/id_ed25519}")"
        if [ -f "$key" ]; then
          echo "✓ ssh key present: $key"
        else
          echo "→ generating ssh key: $key"
          mkdir -p "$(dirname "$key")"
          ssh-keygen -t ed25519 -f "$key" -N "" -C "brokkr-local-sim" && echo "✓ created $key"
        fi
        echo ""
        echo "→ verifying with the doctor report:"
        echo ""
        ${checkScript}
      '';
    };
  };
}
