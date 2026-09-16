{ pkgs, lib, ... }:

# Single source of truth for the repo's treefmt formatting/lint config. Imported two ways so
# dev and CI run the IDENTICAL set:
#   - devenv.nix wires `treefmt.config.imports = [ ./devenv/treefmt-module.nix ]` → the
#     config.treefmt.build.wrapper + the git-hooks.hooks.treefmt pre-commit hook.
#   - devenv/flake.nix evaluates this same file via treefmt-nix.lib.evalModule → the wrapper
#     baked into the lean CI image's ciToolchain, so `task check:format` needs no devenv CLI.
# It is NOT a devenv module (those live in devenv/modules/ and use devenv's option schema); it's
# a treefmt-nix module, hence its placement next to devenv/flake.nix which references it.
{
  # treefmt finds the project root by walking up to the dir containing this file.
  projectRootFile = "pnpm-workspace.yaml";

  # stay quiet about files no enabled formatter claims (images, .env, sql, binaries, …).
  settings.on-unmatched = "info";

  # treefmt walks the whole tree and dispatches by glob, so global excludes must cover everything
  # no enabled formatter should touch — generated/vendored files, lockfiles, build output, the
  # .git/.devenv working dirs, byte-compared test fixtures, and the CI-sensitive YAML. Keep the
  # prettier-owned globs in sync with .prettierignore.
  settings.excludes = [
    ".git/*"
    ".devenv/*"
    "**/node_modules/**"
    "**/dist/**"
    "**/build/**"
    "**/.turbo/**"
    "**/coverage/**"
    "**/*.tsbuildinfo"
    # lockfiles
    "pnpm-lock.yaml"
    "devenv.lock"
    "devenv/flake.lock"
    # generated / drift-checked artifacts (mirror .prettierignore)
    "**/routeTree.gen.ts"
    "apps/api/config/regions.json"
    "THIRD-PARTY-LICENSES.md"
    "packages/database/generated/**"
    "apps/live-agent/src/gen/**"
    "**/sql-seed/_generated/**"
    # prisma-managed (migration SQL + migration_lock.toml)
    "packages/database/prisma/migrations/**"
    # generated pre-commit config (symlink into the nix store)
    ".pre-commit-config.yaml"
    # byte-compared test data — never reformat
    "**/__fixtures__/**"
    "**/fixtures/**"
    "**/test-vectors/**"
    "**/__test__/**"
    "**/__tests__/**"
    # CI-sensitive YAML: GitLab !reference custom tags
    ".gitlab-ci.yml"
    # Helm templates: Go templating, not parseable YAML
    "deploy/helm/*/templates/**"
  ];

  # *.nix — a lint+format pipeline (priority = run order, lower first):
  #   deadnix (remove dead code) → statix (fix anti-patterns) → nixfmt (format last).
  # All three auto-fix, so they ride treefmt's model. This is the Nix LINTING the repo lacked
  # (nixfmt alone is only formatting).
  programs.deadnix.enable = true;
  settings.formatter.deadnix.priority = 1;
  programs.statix.enable = true;
  settings.formatter.statix.priority = 2;
  # RFC-166 formatter. No explicit package: on the pinned nixpkgs `pkgs.nixfmt` already IS
  # nixfmt-rfc-style (1.4.0, same derivation), and naming the alias now warns. nixfmt-classic
  # (0.6.0) remains a separate attribute, so the default cannot regress to it silently.
  programs.nixfmt.enable = true;
  settings.formatter.nixfmt.priority = 3;

  # apps/local-sim/**/*.py — ruff-format honors the sim's pyproject.toml (line-length 120 / py312).
  programs.ruff-format = {
    enable = true;
    includes = [ "apps/local-sim/**/*.py" ];
  };

  # *.sh — shfmt (format). Indent comes from .editorconfig (shfmt reads it natively).
  programs.shfmt.enable = true;

  # *.sh — shellcheck (lint gate; does not auto-fix). Runs after shfmt (higher priority number).
  # Gate at warning+ (severity in Nix, no .shellcheckrc): errors + warnings block, info-level
  # advisories (ls-vs-find SC2012, A&&B||C SC2015, unfollowable-source SC1091) don't — the standard
  # pragmatic policy for adopting shellcheck without nagging on style hints.
  programs.shellcheck.enable = true;
  settings.formatter.shellcheck.priority = 1;
  settings.formatter.shellcheck.options = [ "--severity=warning" ];

  # *.toml — taplo. migration_lock.toml is excluded globally (prisma-managed).
  programs.taplo.enable = true;

  # Dockerfile — hadolint (lint gate; does not auto-fix). Not a treefmt-nix built-in at this pin,
  # so wired as a custom formatter. hadolint reads .hadolint.yaml from the tree root (treefmt's
  # cwd), which ignores DL3008/DL3003. Consolidates the standalone GitLab "Lint Dockerfiles" job.
  settings.formatter.hadolint = {
    command = "${pkgs.hadolint}/bin/hadolint";
    includes = [
      "Dockerfile"
      "**/Dockerfile"
      "*.Dockerfile"
      "*.dockerfile"
    ];
  };

  # *.{ts,tsx,js,mjs,cjs,json,md,mdx,css,scss,yaml,yml} — the PROJECT prettier, NOT a nixpkgs
  # prettier. Execs the repo's node_modules/.bin/prettier so .prettierrc.mjs's plugins
  # (organize-imports, tailwindcss) AND .prettierignore are honored — a nixpkgs prettier lacks
  # the plugins and would reflow imports/Tailwind classes, producing spurious diffs vs `pnpm
  # format`. treefmt passes matched files as positional args; prettier resolves config per file.
  settings.formatter.prettier = {
    command = "${lib.getExe pkgs.bash}";
    options = [
      "-euc"
      ''
        # PRJ_ROOT is exported by treefmt (the resolved project root); fall back to cwd. Use the
        # repo-local prettier so config + plugins resolve regardless of treefmt's invocation cwd.
        bin="''${PRJ_ROOT:-.}/node_modules/.bin/prettier"
        if [ ! -x "$bin" ]; then
          echo "treefmt prettier: $bin not found — run pnpm install" >&2
          exit 1
        fi
        exec "$bin" --write "$@"
      ''
      "--" # terminate bash options so treefmt's file args land in $@
    ];
    includes = [
      "*.ts"
      "*.tsx"
      "*.js"
      "*.mjs"
      "*.cjs"
      "*.json"
      "*.md"
      "*.mdx"
      "*.css"
      "*.scss"
      "*.yaml"
      "*.yml"
    ];
    # prettier reads .prettierignore itself; kept here so the prettier-owned intent is local too.
    excludes = [
      "**/routeTree.gen.ts"
      "THIRD-PARTY-LICENSES.md"
    ];
  };
}
