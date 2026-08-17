{
  config,
  pkgs,
  lib,
  ...
}:

# The simulated fleet as a first-class devenv unit: the bring-up tasks (ensure libvirt,
# seed the hub, build artifacts) plus the supervised `fleet` process that powers the VMs
# on and tears them down on stop. Folding the old Taskfile fleet:* / sim:seed orchestration
# in here makes `devenv up` the 1-shot — control plane + seed + fleet — and lets the control
# center drive the fleet over the same process-compose REST it uses for hub/spoke (start/stop/
# restart the `fleet` process).
#
# DAG: hub-api healthy → sim:seed → (spoke healthy + libvirt:up) → fleet:init → fleet.
# fleet.autoStart=false (modules/overrides.nix) leaves `fleet` defined-but-`disabled`, so
# `devenv up` stops at the control plane and the fleet starts on demand (control center /
# `devenv processes start fleet`); sim:seed + fleet:init only fire when the fleet does (the
# control plane comes up unseeded, same as a bare pre-fleet `devenv up`).
#
# `python -m local.*` needs sim/scripts on PYTHONPATH — enterShell sets that for the
# interactive shell, but pc tasks/processes don't source it, so each sets it explicitly.
#
# Under the dev/stg profiles (remoteInfra.enable) the whole module is gated off — there's no fleet
# against real infra, so none of these tasks/processes are graph nodes (a stray `after` on the
# now-absent spoke would otherwise fail task-graph validation).
let
  inherit (config.devenv) root;
  simDir = "${root}/apps/local-sim";
  pythonPath = "${root}/apps/local-sim/scripts";
  P = (import ./ports.nix).fromConfig config;
  # the sim engine defaults BRIDGE_ENDPOINT/HUB_ENDPOINT to slot 0's :8000/:3000
  # (config.py BridgeSettings/HubSettings) — pin both to the slot-derived ports.
  # BRIDGE_PERSISTENT_STORAGE pins the same per-slot tree the TS bridge serves from
  # (spoke-paths.nix) — otherwise the engine builds initrds into slot 0's dir.
  fleetEndpointEnv = [
    "BRIDGE_ENDPOINT=http://${P.hosts.loopback}:${toString P.ports.spoke.base}"
    "HUB_ENDPOINT=http://${P.hosts.loopback}:${toString P.ports.hubApi.base}"
    "BRIDGE_PERSISTENT_STORAGE=${((import ./spoke-paths.nix).forSlot config.stack.slot).storage}"
  ];
  # zone-crypto keyed (the local-dev default): spoke.nix then defines the `zone-crypto:seed-bmc` task
  # that seals each Server's BMC creds. fleet:init must run AFTER it so the VMs power on with creds
  # already in the DB (BMC/power/SOL ops have something to dispatch). Unkeyed → no seed-bmc → no dep.
  hubKeyed = config.zoneCrypto.hubPrivateKey != "";
  bootstrapFleetYaml = ''
    mkdir -p "$(dirname "$LOCAL_FLEET_PATH")"
    cp -n "$LOCAL_FLEET_SOURCE" "$LOCAL_FLEET_PATH" || true
  '';
in
lib.mkIf (!config.remoteInfra.enable) {
  tasks = {
    "libvirt:up" = {
      description = "ensure libvirt is up (Linux system libvirtd; on macOS the virtqemud process owns this — no-op). Idempotent.";
      exec = "bash ${simDir}/scripts/tasks/stack-libvirt-up.sh";
    };

    # Create the flat L2 data-plane bridge br-brokkr BEFORE the spoke starts, so the spoke's
    # DHCP/DNS (hub atoms target subnets on config.env.LOCAL_DATA_BRIDGE) bind to a real interface.
    # macOS uses socket_vmnet, so this is a no-op there. Idempotent — cmd_up re-ensures it too.
    "data-bridge:up" = {
      description = "ensure the flat L2 data-plane bridge br-brokkr (Linux; macOS no-op). Runs before the spoke so DHCP/DNS bind to it. Idempotent.";
      exec = ''
        export PYTHONPATH="${pythonPath}''${PYTHONPATH:+:$PYTHONPATH}"
        ${bootstrapFleetYaml}
        cd "${simDir}"
        if [ "$(uname)" = Darwin ]; then
          echo "macOS uses socket_vmnet — no L2 data-plane bridge needed"
          exit 0
        fi
        command -v ip >/dev/null 2>&1 || { echo "❌ 'ip' (iproute2) not found — install it (apt install iproute2)." >&2; exit 1; }
        command -v brctl >/dev/null 2>&1 || echo "  · brctl (bridge-utils) absent — using iproute2 'ip link' (fine)."
        export LOCAL_DATA_BRIDGE=${lib.escapeShellArg config.env.LOCAL_DATA_BRIDGE}
        python -m local.fleet ensure-bridge
      '';
    };

    "sim:seed" = {
      description = "generator-driven sim Hub seed (devices / OS catalog / zone / listing). Waits for the admin org, then applies SQL. Idempotent.";
      after = [ "devenv:processes:hub-api" ];
      exec = ''
        export PYTHONPATH="${pythonPath}''${PYTHONPATH:+:$PYTHONPATH}"
        . "${root}/devenv/lib/with-task-log.sh"
        begin_task_log "sim:seed"
        ${bootstrapFleetYaml}
        bash ${simDir}/scripts/tasks/sql-seed-run.sh
      '';
    };

    "fleet:init" = {
      description = "build brokkr-live.img + bridge-agent.img + per-VM iPXE binaries + warm the spoke cache. Slow, idempotent.";
      # libvirt must be up before preflight's `virsh list`: macOS depends on the supervised
      # virtqemud process; Linux on the `libvirt:up` task (system libvirtd). OS-exclusive — Linux
      # never references the macOS-`disabled` virtqemud process (an unsatisfiable dep would stall).
      after = [
        "sim:seed"
        "devenv:processes:spoke"
      ]
      ++ lib.optionals hubKeyed [ "zone-crypto:seed-bmc" ]
      ++ (if pkgs.stdenv.isDarwin then [ "devenv:processes:virtqemud" ] else [ "libvirt:up" ]);
      # begin_task_log's per-task lock (devenv/lib/with-task-log.sh) is also this oneshot's
      # single-flight: without it a cold `task up` runs one concurrent iPXE build per upstream
      # runner. The first holder builds; the queued ones no-op via the build scripts' mtime
      # skip-guards, so python must stay INSIDE the lock — hence no `exec` before it, which would
      # replace the shell before the releasing EXIT trap could run.
      exec = ''
        export PYTHONPATH="${pythonPath}''${PYTHONPATH:+:$PYTHONPATH}"
        # prompt per-line flushing so the tee'd [init] log pane streams live, not in bursts (the
        # fleet PROCESS gets this via process-compose.environment; the task exec sets it here).
        export PYTHONUNBUFFERED=1
        ${lib.concatMapStringsSep "\n" (e: "export ${e}") fleetEndpointEnv}
        ${bootstrapFleetYaml}
        cd "${simDir}"

        . "${root}/devenv/lib/with-task-log.sh"
        begin_task_log "fleet:init"

        python -m local.fleet init
      '';
    };
  };

  # macOS user-session libvirt daemon, supervised. Was a fire-and-forget Popen in
  # daemons.start_virtqemud (no restart/health, orphaned past teardown, invisible in `task logs`);
  # as a process-compose process it gets all three, and the fleet `after`s it instead of the old
  # in-process call. `--timeout 0` disables libvirt's 120s idle exit (which would drop the socket
  # mid-saga and fail ipmi_sim's next chassis call). NO `--daemon` — that forks/detaches and pc would see an
  # instant exit; foreground keeps pc the supervisor. On Linux libvirt is a system service devenv
  # doesn't own, so the process is `disabled` and `libvirt:up` handles libvirtd there.
  processes.virtqemud = {
    # `disabled` is a process-compose passthrough (no devenv-native equivalent). The readiness
    # probe MUST be devenv-native `ready` (not `process-compose.readiness_probe`): the `@ready`
    # dependency other processes/tasks place on virtqemud is validated at task-graph eval against
    # `ready`/`listen`/`ports` — the raw passthrough is invisible there. Exec probe because
    # virtqemud has no TCP port (unix-socket daemon), so the `listen`/`ports` branches don't apply.
    process-compose = {
      disabled = pkgs.stdenv.isLinux;
      namespace = "fleet";
      description = "libvirt daemon";
    };
    ready = {
      # narrow arg-string match (not bare `virtqemud`) so a stale `--daemon` orphan can't false-pass.
      exec = "pgrep -f 'virtqemud --timeout 0'";
      initial_delay = 1;
      period = 2;
      probe_timeout = 5;
      failure_threshold = 30;
    };
    restart.on = "on_failure";
    # Adopt-or-spawn via the wrapper: one user-session virtqemud serves every stack on this
    # host, so never pkill here (a sibling stack's VMs hang off the same daemon). The script's
    # trailing exec keeps the signal path direct: spawned → pc's child IS virtqemud; adopted →
    # a no-op tail holder whose death on stack teardown leaves the shared daemon alone.
    exec = ''
      exec bash ${../lib/virtqemud-wrapper.sh}
    '';
  };

  # The running fleet — supervised so the control center can start/stop/restart it over the
  # pc REST, logs stream over the same WebSocket, and `devenv down` tears it down. `up
  # --supervise` powers the VMs on then blocks; on SIGTERM it runs `fleet down`.
  processes.fleet = {
    # macOS: also a direct dep on virtqemud so a bare `devenv processes restart fleet` (which may
    # skip fleet:init) still waits on it. Linux gets the libvirt readiness transitively via fleet:init.
    after = [ "fleet:init" ] ++ lib.optionals pkgs.stdenv.isDarwin [ "devenv:processes:virtqemud" ];
    cwd = simDir;
    process-compose = {
      namespace = "fleet";
      description = "Simulated fleet";
      # defined-but-not-auto-started when fleet.autoStart=false; the lab/CLI starts it on demand.
      disabled = !config.fleet.autoStart;
      # LOCAL_FLEET_PATH is pinned per-process (not just shell-inherited) so the control center can
      # hot-apply a topology change: editing the fleet rewrites stack.local.nix → `devenv build` +
      # `project update` swaps this entry → restarting the fleet renders the new topology. (A bare
      # shell-level env can't be hot-reloaded — the running pc server keeps its launch-time value.)
      # PYTHONUNBUFFERED so log lines flush to the captured stdout log promptly (pc gives the
      # process a pipe, not a TTY, so Python would otherwise block-buffer the supervise output).
      environment = [
        "PYTHONUNBUFFERED=1"
        "PYTHONPATH=${pythonPath}"
        "LOCAL_FLEET_SOURCE=${config.env.LOCAL_FLEET_SOURCE}"
        "LOCAL_FLEET_PATH=${config.env.LOCAL_FLEET_PATH}"
        "LOCAL_DATA_BRIDGE=${config.env.LOCAL_DATA_BRIDGE}"
      ]
      ++ fleetEndpointEnv;
      # exit-code-only readiness: every node's libvirt domain is `running` (sudo-free — a
      # ipmi_sim/sushy startup failure already makes `up` exit non-zero before this matters).
      readiness_probe = {
        exec.command = "python -m local.status --ready";
        initial_delay_seconds = 10;
        period_seconds = 5;
        timeout_seconds = 10;
        failure_threshold = 60;
      };
      # No shutdown.command (that would replace the signal): pc sends SIGTERM, the
      # `up --supervise` handler catches it and runs `fleet down`. Generous timeout so the
      # teardown (stop ipmi_sim/sushy, undefine domains) completes before pc escalates to SIGKILL.
      shutdown = {
        signal = 15;
        timeout_seconds = 120;
      };
    };
    # Bash wrapper for the bootstrap copy, then `exec python` so SIGTERM replaces bash → reaches
    # python directly for the supervise handler.
    exec = ''
      ${bootstrapFleetYaml}
      exec python -m local.fleet up --supervise
    '';
  };
}
