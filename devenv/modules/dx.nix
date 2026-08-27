{
  pkgs,
  lib,
  ...
}:

# Git hooks as a devenv concern. devenv's git-hooks integration installs the
# .git/hooks dispatcher on shell entry, so `direnv allow` is the only bootstrap — this
# replaces husky (whose hooks only landed on `pnpm install`, outside the Nix entry point).
# The whole pre-commit surface is declarative here (no lint-staged): treefmt is the
# format/lint authority (config in devenv/treefmt-module.nix), eslint --fix + prisma format
# run as native hooks on the staged file set, the commit-msg rules live in
# commitlint.config.mjs, and the secret-scan allowlist in .gitleaks.toml/.gitleaksignore.
# gitleaks is the Nix-pinned pkgs.gitleaks (not an optional brew binary), so the scan always runs.
let
  maxCommentLinesScript = ../../scripts/agent-hooks/max-comment-lines.mjs;

  # ported from the former .husky/pre-push: link the workspace first (catches newly added
  # packages), full typecheck, then tests for packages affected since origin/master
  # (e2e excluded — it's skipped project-wide).
  prePush = pkgs.writeShellScript "brokkr-pre-push" ''
    set -euo pipefail

    # Render output live on the terminal instead of letting prek buffer it (prek surfaces a
    # hook's captured output only on failure). Pairs with turbo's stream renderer below. No
    # /dev/tty (CI / non-interactive push) → leave stdio as-is.
    if { : >/dev/tty; } 2>/dev/null; then
      exec >/dev/tty 2>&1 </dev/tty
    fi

    echo "Ensuring workspace dependencies are installed..."
    if command -v brokkr-pnpm-install >/dev/null 2>&1; then
      brokkr-pnpm-install --frozen-lockfile
    else
      pnpm install --frozen-lockfile
    fi
    # turbo's interactive TUI (turbo.json `ui: "tui"`) panics under prek — its crossterm input
    # reader has no controlling terminal as a wrapped git hook ("reader source not set"). Force
    # the stream renderer for the pre-push run.
    echo "Running type checks..."
    pnpm turbo run typecheck --ui stream
    echo "Running tests for affected packages..."
    pnpm turbo run test --filter=...[origin/master] --filter=!@repo/e2e --ui stream
  '';

  # Linked worktrees share .git/hooks but git runs hooks with CWD at the worktree root.
  # devenv writes .pre-commit-config.yaml (gitignored) per checkout on shell entry; a worktree
  # that never entered the shell lacks it and prek fails with "config file not found". Resolve
  # the worktree's config when present, else fall back to the primary checkout beside .git/.
  prekConfigResolver = pkgs.writeShellScript "brokkr-prek-config-path" ''
    set -euo pipefail
    root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
    config="$root/.pre-commit-config.yaml"
    if [ ! -f "$config" ]; then
      common="$(git rev-parse --git-common-dir 2>/dev/null || true)"
      if [ -n "$common" ]; then
        main_root="$(cd "$common/.." && pwd)"
        config="$main_root/.pre-commit-config.yaml"
      fi
    fi
    printf '%s\n' "$config"
  '';

  # the sim's hub-schema drift gate. prePush above is TS/turbo-only, so nothing there notices a
  # prisma rename that breaks the sql seed generators or either device-reset implementation —
  # those name hub tables/columns as raw SQL. Offline (parses files, no DB).
  # Pin the Nix pythonEnv (with pytest) — bare `python3` resolves to Homebrew outside a
  # devenv-loaded PATH and fails with "No module named pytest".
  schemaDriftPython = import ../pkgs/python-env.nix {
    python3Packages = pkgs.python312Packages;
  };
  schemaDriftGate = pkgs.writeShellScript "brokkr-local-sim-schema-drift" ''
    set -euo pipefail
    cd "$(git rev-parse --show-toplevel)/apps/local-sim"
    exec ${schemaDriftPython}/bin/python3 -m pytest tests/test_seed_schema_drift.py tests/test_reset_parity.py -q
  '';

  # One list, two consumers: prek's cheap `files` pre-filter, and batsGate re-applying it to the
  # branch diff, which is the scope prek cannot compute.
  batsGateFiles = "(install\\.sh|devenv\\.nix|Taskfile\\.yml|devenv/(lib/.*|modules/[^/]*\\.nix|scripts/[^/]*\\.sh|tests/([^/]*|nix/.*))|apps/local-sim/(scripts/tasks/(stack-reconcile|stack-libvirt-up)\\.sh|provisioning/linux-bootstrap\\.sh))$";

  # the devenv shell suite's darwin half: the only run of either tier against real BSD userland,
  # which is the divergence most of these matchers exist to survive.
  batsGate = pkgs.writeShellScript "brokkr-devenv-bats" ''
    set -euo pipefail
    cd "$(git rev-parse --show-toplevel)"
    # Pin only tools whose absence outside a devenv PATH is fatal and whose behavior is not
    # platform-carrying. Deliberately NOT ps/pgrep/lsof/grep/sed/awk — prepending nix (GNU/procps)
    # versions on darwin would normalize away the divergence this hook exists to catch.
    export PATH="${
      pkgs.lib.makeBinPath [
        pkgs.bats
        pkgs.python3
        pkgs.go-task
        pkgs.git
      ]
    }:$PATH"
    # prek scopes a pre-push hook on what the remote lacks, so a rebase hands it every path
    # master gained - measured 3 matches on a branch owning 0. The branch diff is the real input.
    base=$(git merge-base origin/master HEAD 2>/dev/null) || base=""
    changed=""
    if [ -n "$base" ]; then
      changed=$(git diff --name-only "$base" HEAD)
      if ! printf '%s\n' "$changed" | grep -qE '${batsGateFiles}'; then
        echo "devenv-shell-tests: nothing on this branch touches the tier - skipping"
        exit 0
      fi
    fi

    # checkout/ stays out: those cases refuse to run in a linked worktree, and this host has
    # dozens, so a recursive run would fail every push.
    tier=""
    for f in devenv/tests/*.bats \
             devenv/tests/nix/*.bats; do
      case "$f" in */stack-reconcile.bats) continue ;; esac
      tier="$tier $f"
    done
    # stack-reconcile is 219s of the suite's 336s for 23 of 289 cases, so it runs only when its
    # own inputs move. Every other push gets the remaining 266 cases in 79s.
    if printf '%s\n' "$changed" | grep -qE 'stack-reconcile\.(sh|bats)$'; then
      tier="$tier devenv/tests/stack-reconcile.bats"
    fi

    # A hang guard, not a budget: the suite grew 287s to 336s in a day, so a tight number fails
    # on the clock, not on a defect. Store path because timeout is GNU-only on a darwin push.
    exec ${pkgs.coreutils}/bin/timeout 900 bats $tier
  '';
in
{
  # git-hooks.package is deliberately unset: devenv defaults it to pkgs.prek, which our pinned
  # nixpkgs now carries. The former override pulled prek from a second nixpkgs input.

  git-hooks.hooks = {
    # the repo's format/lint authority (config: devenv/treefmt-module.nix). Runs on the staged
    # file set; fail-on-change (default) makes it a gate — re-stage & recommit after a fix.
    treefmt.enable = true;

    # eslint --fix on staged JS/TS (linting; treefmt owns formatting). prek passes the staged
    # matching files. Same fail-on-change model as treefmt, so the whole pre-commit surface is
    # one consistent gate.
    eslint-fix = {
      enable = true;
      entry = "pnpm exec eslint --fix";
      files = "\\.(ts|tsx|js|mjs|cjs)$";
      pass_filenames = true;
      stages = [ "pre-commit" ];
    };

    # prisma format on any staged schema file. Multi-file schema (prismaSchemaFolder) → match the
    # whole prisma dir; `prisma format` reformats the folder, so no per-file args.
    prisma-format = {
      enable = true;
      entry = "pnpm --filter @repo/database exec prisma format";
      files = "packages/database/prisma/.*\\.prisma$";
      pass_filenames = false;
      stages = [ "pre-commit" ];
    };

    # built-in hook; override only the entry to keep the repo's --staged + --config behavior
    # while sourcing the binary from the pinned nixpkgs.
    gitleaks = {
      enable = true;
      entry = "${pkgs.gitleaks}/bin/gitleaks protect --staged --config .gitleaks.toml";
      pass_filenames = false;
    };

    # the commit-msg stage appends the message-file path → `commitlint --edit <file>`.
    commitlint = {
      enable = true;
      entry = "pnpm exec commitlint --edit";
      stages = [ "commit-msg" ];
    };

    pre-push-checks = {
      enable = true;
      entry = "${prePush}";
      pass_filenames = false;
      # run on every push: without this prek gates the hook on the push's changed-file set and
      # skips it ("no files to check") when that diff is empty — already-pushed commits, tag
      # pushes, branch deletes, or a range prek can't compute. always_run forces it each push.
      always_run = true;
      stages = [ "pre-push" ];
    };

    # `files` records the gate's real input set; `always_run` is what makes it fire, since prek
    # skips file-scoped hooks whenever the push diff is empty (see pre-push-checks above).
    local-sim-schema-drift = {
      enable = true;
      entry = "${schemaDriftGate}";
      files = "(apps/local-sim/.*\\.(py|sql)|apps/local-sim/tests/fixtures/.*\\.yml|packages/database/prisma/.*\\.prisma|apps/local-lab/src/fleet/fleet-reset\\.service\\.ts|devenv/modules/(polyrepo|sudo)\\.nix|devenv\\.nix|Taskfile\\.yml)$";
      pass_filenames = false;
      always_run = true;
      stages = [ "pre-push" ];
    };
    # deliberately NOT always_run, unlike the two gates above: their inputs are cross-cutting, so
    # skipping them on an empty push diff loses coverage. This gate's inputs ARE its `files` set,
    # so an empty diff means there is genuinely nothing to check — and always_run would charge
    # every push in the repo the full run.
    devenv-shell-tests = {
      enable = true;
      entry = "${batsGate}";
      files = "${batsGateFiles}";
      pass_filenames = false;
      always_run = false;
      stages = [ "pre-push" ];
    };
  }
  # always_run leaves no file glob to skip on, so the hook must not exist at all where its
  # script does not — scripts/ is internal-only and absent from the public mirror.
  // lib.optionalAttrs (builtins.pathExists maxCommentLinesScript) {
    max-comment-lines = {
      enable = true;
      entry = "node scripts/agent-hooks/max-comment-lines.mjs --staged";
      pass_filenames = false;
      always_run = true;
      stages = [ "pre-commit" ];
    };
  };

  # prek paints a progress spinner over the terminal while a hook runs; for pre-push that
  # collides with the hook's full-screen turbo TUI (turbo.json `ui: "tui"`) and panics turbo.
  # prek's --no-progress fixes it but is flag-only (no env binding), and the installed shim
  # bakes in prek's own resolved path, so a package wrapper is bypassed. Patch the generated
  # pre-push shim in place instead — scoped to pre-push so commit-stage hooks keep their
  # progress output. Runs after the devenv git-hooks install task, before shell entry.
  tasks."brokkr:pre-push-no-progress" = {
    exec = ''
      shim="$(git rev-parse --git-path hooks)/pre-push"
      if [ -f "$shim" ] && grep -q ' hook-impl' "$shim" && ! grep -q -- '--no-progress' "$shim"; then
        tmp="$(mktemp)"
        sed 's/ hook-impl/ --no-progress hook-impl/' "$shim" >"$tmp" && cat "$tmp" >"$shim"
        rm -f "$tmp"
      fi
    '';
    after = [
      "devenv:git-hooks:install"
      "brokkr:worktree-prek-config"
    ];
    before = [ "devenv:enterShell" ];
  };

  # prek shims bake in --config=".pre-commit-config.yaml" (CWD-relative). Patch to an absolute
  # path so linked worktrees inherit the primary checkout's generated config when they lack their
  # own. Idempotent marker: brokkr-prek-config-path in the shim.
  tasks."brokkr:worktree-prek-config" = {
    exec = ''
      resolver="${prekConfigResolver}"
      for hook in pre-commit commit-msg pre-push; do
        shim="$(git rev-parse --git-path hooks)/$hook"
        [ -f "$shim" ] || continue
        grep -q 'brokkr-prek-config-path' "$shim" && continue
        grep -q 'hook-impl' "$shim" || continue
        tmp="$(mktemp)"
        sed "s|--config=\".pre-commit-config.yaml\"|--config=\"\$(\"$resolver\")\"|" "$shim" >"$tmp" && cat "$tmp" >"$shim"
        rm -f "$tmp"
      done
    '';
    after = [ "devenv:git-hooks:install" ];
    before = [ "devenv:enterShell" ];
  };

  # a clone migrated off husky still carries core.hooksPath=.husky/_ in its local git config, which
  # redirects git away from the .git/hooks dispatcher installed below — the stale .husky shims would
  # run instead. Clear it on shell entry, before the install, so both the install and git resolve to
  # .git/hooks. Scoped to husky-owned values so a deliberately-customized hooksPath is left alone;
  # idempotent (only unsets on a match).
  tasks."brokkr:clear-stale-husky-hookspath" = {
    exec = ''
      current="$(git config --local --get core.hooksPath || true)"
      case "$current" in
        .husky | .husky/*) git config --local --unset core.hooksPath ;;
      esac
    '';
    before = [ "devenv:git-hooks:install" ];
  };

  # auto-configure `git blame` to skip the bulk formatting commits (.git-blame-ignore-revs), so
  # line attribution points at the prior substantive change, not the mechanical reformat. Set
  # per-worktree (extensions.worktreeConfig): linked worktrees share .git/config, and a SHARED
  # blame.ignoreRevsFile pointing at a file a sibling worktree lacks fatals `git blame` there.
  # Clears any stale shared value first; idempotent. (GitLab honors the file automatically.)
  tasks."brokkr:enable-blame-ignore-revs" = {
    exec = ''
      root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
      [ -n "$root" ] || exit 0
      revs=".git-blame-ignore-revs"
      [ "$(git config --local --get blame.ignoreRevsFile 2>/dev/null || true)" = "$revs" ] \
        && git config --local --unset blame.ignoreRevsFile || true
      if [ -f "$root/$revs" ]; then
        git config --local extensions.worktreeConfig true
        [ "$(git config --worktree --get blame.ignoreRevsFile 2>/dev/null || true)" = "$revs" ] \
          || git config --worktree blame.ignoreRevsFile "$revs"
      elif git config --local --get extensions.worktreeConfig >/dev/null 2>&1; then
        [ "$(git config --worktree --get blame.ignoreRevsFile 2>/dev/null || true)" = "$revs" ] \
          && git config --worktree --unset blame.ignoreRevsFile || true
      fi
    '';
    before = [ "devenv:enterShell" ];
  };
}
