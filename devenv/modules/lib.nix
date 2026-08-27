# shared helpers for the hub + spoke devenv modules.
let
  # Paired here because env-pins.nix must resolve a pin to the overrides attrs without reading
  # knobMeta — a module's config paths may not depend on another option's value.
  envKnobDefaults = group: "stackDefaults.${group}";
  envKnobOverride = group: "stackOverrides.${group}";
in
{
  inherit envKnobDefaults envKnobOverride;

  # devenv's dotenv loads HUB_REPO_PATH verbatim — no ~ or $HOME interpolation — so resolve a
  # leading ~ or $HOME at use-site (absolute paths pass through), then cd into the repo. used by
  # the hub/spoke execs in place of an inline expansion.
  cdRepo = var: ''__repo="''${${var}/#\~/$HOME}"; __repo="''${__repo/#\$HOME/$HOME}"; cd "$__repo"'';

  # `aliases` is read back from the module's own knob-to-env remap rather than restated, so the
  # published list cannot drift from the remap that produces it.
  envKnobMeta =
    lib: group: aliases: knobs:
    lib.mapAttrs' (env: meta: {
      name = "${envKnobDefaults group}.${env}";
      value = meta // {
        overrideFrom = envKnobOverride group;
        alias = aliases.${env} or [ ];
      };
    }) knobs;

  # eval-time companion to cdRepo: bake a leading ~ / $HOME into an absolute path so the derived
  # repo-path env vars are absolute for consumers that DON'T expand at use-site (the control
  # center's Node spawn cwd, .envrc's [ -d ] checks). lib + home are passed by the caller
  # (devenv.nix reads home impurely via builtins.getEnv "HOME", as spoke.nix does for sshKey).
  # Empty home (pure eval / CI flake check) → leave the ~ for the shell/python use-site expanders;
  # cdRepo still handles a literal ~ arriving from .env/dotenv.
  expandHome =
    lib: home: p:
    if home == "" then
      p
    else if lib.hasPrefix "~/" p then
      home + lib.removePrefix "~" p
    else if lib.hasPrefix "$HOME/" p then
      home + lib.removePrefix "$HOME" p
    else
      p;
}
