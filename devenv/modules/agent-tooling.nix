# Agent-facing tooling every checkout gets: the brokkr-lab MCP server, a pre-approved read-only
# slice of it, and a guard over the verbs that reach outside this checkout's own stack slot.
{ pkgs, ... }:
let
  # The permission deny rules below cover the literal spellings only; this hook is the enforcing
  # half, because any shell that spells the same command differently sidesteps a prefix rule.
  # It fires on stack-stopping commands only: a single-command read of these verb names is allowed,
  # so searching a doc for `task down:all` is not collateral damage.
  hostWideStackGuard = pkgs.writeShellApplication {
    name = "claude-host-wide-stack-guard";
    runtimeInputs = [
      pkgs.jq
      pkgs.coreutils
    ];
    text = ''
      # the decision is a pure function of the command text, so the container-safe bats tier can
      # exercise it with no JSON tool on PATH. jq stays at the stdin/stdout boundary.
      guard_decision() { # <raw command> -> a deny reason on stdout, nothing when allowed
        local raw cmd reason
        raw="$1"
        cmd="$(printf '%s' "$raw" | tr '\n\t' '  ' | tr -s ' ')"

        # a pure read cannot stop a stack, so let it through — but only when nothing in the command
        # could start a second one, or `grep x f; task down:all` would sail past the deny below.
        # the newline test reads $raw, because normalising it into a space would hide the second line.
        if [ "$(printf '%s' "$raw" | wc -l)" -eq 0 ]; then
          case "$cmd" in
          *";"* | *"&"* | *"|"* | *'`'* | *"\$("* | *"system("* | *"exec("*) ;;
          "rg "* | "grep "* | "cat "* | "sed "* | "awk "* | "head "* | "tail "* | "less "* | \
            "wc "* | "diff "* | "git log "* | "git grep "* | "git show "*)
            return 0
            ;;
          esac
        fi

        reason=""
        case "$cmd" in
        *task*down:all* | *stack-down-all*)
          reason="Denied: down:all stops EVERY checkout's stack on this host, including other agents' live stacks. To end your own stack only, run \`task down\`; to end it and hand the slot back, \`task stack:release\`."
          ;;
        *task*down:others* | *stack-down-others*)
          reason="Denied: down:others stops other checkouts' stacks — those belong to other agents. Sibling stacks are reported by \`task local:status\`; leave them running."
          ;;
        *task*purge:all* | *stack-purge-all*)
          reason="Denied: purge:all wipes EVERY registered slot's data on this host. For your own slot use \`task local:purge\`, or \`task stack:release\` to return the slot."
          ;;
        *task*test:devenv:all*)
          reason="Denied: the devenv checkout bats tier writes into a real checkout and can churn a live stack.slot.nix. Run the container-safe tier instead: \`bats devenv/tests/<file>.bats\`."
          ;;
        *bats*-r*devenv/tests* | *bats*devenv/tests/checkout*)
          reason="Denied: devenv/tests/checkout writes into a real checkout and can delete a live stack.slot.nix. Name the container-safe files instead: \`bats devenv/tests/<file>.bats\`."
          ;;
        esac

        printf '%s' "$reason"
      }

      raw="$(jq -r '.tool_input.command // ""')"
      reason="$(guard_decision "$raw")"
      [ -n "$reason" ] || exit 0
      jq -n --arg reason "$reason" '{
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: $reason
        }
      }'
      exit 0
    '';
  };
in
{
  # No `env`: the server resolves its own slot from the host slot registry, and a pinned LAB_MCP_URL
  # would defeat that. `pnpm --filter ... dev` rather than the built output — see its README.
  claude.code.mcpServers."brokkr-lab" = {
    type = "stdio";
    command = "pnpm";
    args = [
      "--filter"
      "local-lab-mcp"
      "dev"
    ];
  };

  # Re-declared verbatim from the devenv module's own default: mcpServers is an attrsOf option, so
  # the default is discarded the moment any definition exists, and brokkr-lab alone would drop it.
  claude.code.mcpServers."mcp.devenv.sh" = {
    type = "http";
    url = "https://mcp.devenv.sh";
  };

  # Read-only lab tools — auto-allowed so validation queries don't prompt. lab_pg_query is here
  # because the server enforces read-only in pg.service.ts, not because the tool name says so.
  claude.code.permissions."mcp__brokkr-lab__lab_get_*".allow = [ "" ];
  claude.code.permissions."mcp__brokkr-lab__lab_list_*".allow = [ "" ];
  claude.code.permissions."mcp__brokkr-lab__lab_pg_*".allow = [ "" ];
  claude.code.permissions."mcp__brokkr-lab__lab_redis_*".allow = [ "" ];
  claude.code.permissions."mcp__brokkr-lab__lab_thanos_query".allow = [ "" ];
  claude.code.permissions."mcp__brokkr-lab__lab_fleet_verify".allow = [ "" ];
  claude.code.permissions."mcp__brokkr-lab__lab_fleet_console_log".allow = [ "" ];
  claude.code.permissions."mcp__brokkr-lab__lab_verify_storage".allow = [ "" ];

  # lab_use_stack only picks which slot the other tools address — it mutates nothing, and a prompt
  # would gate the recovery step for a checkout that owns no slot. Each result names the target.
  claude.code.permissions."mcp__brokkr-lab__lab_use_stack".allow = [ "" ];

  # lab_run_test is deliberately absent: the scenario argument decides the blast radius, and a
  # tool-name pattern cannot express that. Same for every fleet/control/stack mutation.
  claude.code.permissions.Bash.deny = [
    "task down:all"
    "task down:all:*"
    "task down:others"
    "task down:others:*"
    "task purge:all"
    "task purge:all:*"
    "task test:devenv:all"
    "task test:devenv:all:*"
    "bats -r devenv/tests"
    "bats -r devenv/tests:*"
    "bats devenv/tests/checkout"
    "bats devenv/tests/checkout:*"
  ];

  claude.code.hooks.host-wide-stack-guard = {
    hookType = "PreToolUse";
    matcher = "Bash";
    command = "${hostWideStackGuard}/bin/claude-host-wide-stack-guard";
  };
}
