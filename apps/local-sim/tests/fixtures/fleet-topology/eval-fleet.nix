{
  repo,
  overlay ? { },
}:
let
  nixpkgs = builtins.getFlake "nixpkgs";
  pkgs = import nixpkgs.outPath { system = builtins.currentSystem; };
  lib = pkgs.lib;
  eval = lib.evalModules {
    modules = [
      (repo + "/devenv/modules/fleet-topology.nix")
      (
        { lib, ... }:
        {
          options.env = lib.mkOption {
            type = lib.types.lazyAttrsOf lib.types.raw;
            default = { };
          };
          options.devenv.root = lib.mkOption {
            type = lib.types.str;
            default = "/repo";
          };
          # fleet-topology.nix contributes fleet.mode's presentation metadata to the
          # knobMeta registry that modules/overrides.nix declares. This eval is
          # standalone, so declare a loose stand-in — the fixture only reads fleet.yml.
          options.knobMeta = lib.mkOption {
            type = lib.types.attrsOf lib.types.raw;
            default = { };
          };
          options.stack = {
            slot = lib.mkOption {
              type = lib.types.ints.between 0 46;
              default = 0;
            };
            fleetNodeCount = lib.mkOption {
              type = lib.types.ints.between 1 4;
              default = 4;
            };
          };
          config.env.DEVENV_STATE = "/state";
          config._module.args.pkgs = pkgs;
        }
      )
      overlay
    ];
  };
in
{
  fleetYaml = builtins.readFile eval.config.env.LOCAL_FLEET_SOURCE;
}
