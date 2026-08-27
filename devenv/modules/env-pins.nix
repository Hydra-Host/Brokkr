{
  config,
  lib,
  options,
  ...
}:

# BROKKR_CFG_* / BROKKR_PIN_* rendered into a gitignored ./env.local.nix. The renderer validates
# nothing: the option surface is the allowlist and each declared type is the parser.
let
  helpers = import ./lib.nix;

  # Read from the file, not config.brokkrEnvPins: a config path derived from an option's value is
  # infinite recursion. The assertion below keeps the two reads agreeing.
  pinFile = ../../env.local.nix;
  fromFile = attr: if builtins.pathExists pinFile then (import pinFile).${attr} or { } else { };
  filePins = fromFile "brokkrEnvPins";
  fileVars = fromFile "brokkrEnvPinVars";

  # No builtins.getEnv: the supervised process the control center evals from has a different
  # environment than the terminal, so a getEnv pin would resolve two ways.
  canonicalVar = path: "BROKKR_CFG_" + builtins.replaceStrings [ "." ] [ "__" ] path;
  varOf = path: fileVars.${path} or (canonicalVar path);
  fail = path: msg: throw "brokkrEnvPins: ${varOf path} pins '${path}', which ${msg}.";

  optAt = parts: if lib.hasAttrByPath parts options then lib.getAttrFromPath parts options else null;

  # This module's own options are not pinnable: a pin on one of them would make the config paths
  # depend on the very value they are derived from.
  reserved = [
    "brokkrEnvPins"
    "brokkrEnvPinVars"
    "envPins"
    "assertions"
  ];

  # An env-knob path is a key inside an attrsOf with no option of its own, so its pin lands in the
  # paired overrides attrs — upstream of mapHubOverrides, or the alias fan-out is skipped.
  resolveTarget =
    path:
    let
      parts = lib.splitString "." path;
      opt = optAt parts;
      container = optAt (lib.init parts);
      group = lib.last (lib.init parts);
      isEnvKnob =
        container != null
        && lib.isOption container
        && lib.concatStringsSep "." (lib.init parts) == helpers.envKnobDefaults group;
    in
    if opt != null && lib.isOption opt then
      {
        target = parts;
        inherit (opt) type;
      }
    else if isEnvKnob then
      {
        target = lib.splitString "." (helpers.envKnobOverride group) ++ [ (lib.last parts) ];
        type = container.type.nestedTypes.elemType;
      }
    else
      null;

  # Coercion keys on the REAL type names, not the catalog's display `kind`: a port is
  # `unsignedInt16` and stack.slot is `intBetween`. Anything non-scalar is refused, not guessed at.
  intTypes = [
    "int"
    "intBetween"
    "positiveInt"
    "unsignedInt"
    "unsignedInt16"
  ];
  coerce =
    path: type: raw:
    let
      parsed = builtins.tryEval (lib.toInt raw);
      choices = map toString (type.functor.payload.values or [ ]);
    in
    if type.name == "bool" then
      if raw == "true" then
        true
      else if raw == "false" then
        false
      else
        fail path "expects 'true' or 'false', got '${raw}'"
    else if lib.elem type.name intTypes then
      if parsed.success then parsed.value else fail path "expects an integer, got '${raw}'"
    else if type.name == "enum" then
      if lib.elem raw choices then
        raw
      else
        fail path "expects one of ${lib.concatStringsSep ", " choices}, got '${raw}'"
    else if type.name == "str" || type.name == "path" then
      raw
    else
      fail path "is not a scalar option (type '${type.name}')";

  # The assertion is what a bring-up trips on; the throw is what stops the pin under a bare
  # `devenv eval`, which checks no assertions.
  # DATABASE_URL embeds identity.pg.password, so refusing the password alone leaves the bypass open.
  # Listed, not derived: reading a knob's value here is the recursion the two-read split avoids.
  carriesSecret = [ "stackDefaults.hub.DATABASE_URL" ];

  # An attrsOf key resolves through resolveTarget's second branch, where the "option surface is the
  # allowlist" rule cannot hold: the key has no option of its own, so only the catalog vouches for it.
  hasOwnOption =
    path:
    let
      o = optAt (lib.splitString "." path);
    in
    o != null && lib.isOption o;

  refusalFor =
    path:
    let
      meta = config.knobMeta.${path} or null;
    in
    if meta == null then
      (
        if hasOwnOption path then
          null
        else
          "it is not a catalogued knob, and its container takes any key — see `devenv eval knobCatalog`"
      )
    else if !meta.editable then
      "it is a read-only knob"
    else if meta.secret then
      "it is a secret"
    else if lib.elem path carriesSecret then
      "its value embeds a secret knob's value"
    else
      null;

  resolve =
    path: raw:
    let
      resolved = resolveTarget path;
      refusal = refusalFor path;
    in
    {
      inherit path;
      var = varOf path;
      inherit refusal;
      targetParts =
        if resolved == null then
          fail path "is not a known option — see `devenv eval knobCatalog`"
        else if lib.elem (lib.head resolved.target) reserved then
          fail path "names an option the pin mechanism itself owns"
        else
          resolved.target;
      value =
        if refusal != null then
          fail path "may not be pinned: ${refusal}"
        else
          coerce path resolved.type raw;
    };

  entries = lib.mapAttrsToList resolve filePins;
  refused = lib.filter (e: e.refusal != null) entries;
in
{
  options = {
    brokkrEnvPins = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Dotted knob path → raw string value, written into ./env.local.nix by devenv/scripts/render-env-pins.sh. Coerced here by the target option's own declared type.";
    };

    brokkrEnvPinVars = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Dotted knob path → the environment variable that set it, so a message names the variable to unset rather than the canonical form the developer may not have used.";
    };

    envPins = lib.mkOption {
      type = lib.types.listOf (
        lib.types.submodule {
          options = {
            path = lib.mkOption {
              type = lib.types.str;
              description = "Dotted knob path this pin applies to.";
            };
            var = lib.mkOption {
              type = lib.types.str;
              description = "Environment variable holding the pin — what to unset to release the knob.";
            };
          };
        }
      );
      default = [ ];
      description = "Knobs pinned from the environment, sorted by path. The control center locks these in its UI: an overlay write would be outranked at eval and silently discarded.";
    };

    envPinRefusals = lib.mkOption {
      type = lib.types.listOf (
        lib.types.submodule {
          options = {
            path = lib.mkOption {
              type = lib.types.str;
              description = "Catalogued knob path a pin is refused on.";
            };
            reason = lib.mkOption {
              type = lib.types.str;
              description = "Why the pin is refused, in the words the failing eval uses.";
            };
          };
        }
      );
      default = [ ];
      description = "Every catalogued path a pin is refused on, sorted by path. A list rather than an attrset because a knob path carries dots, which `devenv eval` reads as attribute traversal. Published so the generated reference and the control center state the reason instead of re-deriving it.";
    };
  };

  # mkOverride 60 outranks stack.local.nix without displacing an mkForce, and is applied PER KEY:
  # a whole-attrset override would discard every sibling the control center wrote.
  config = lib.foldl' lib.recursiveUpdate {
    assertions = [
      {
        assertion = config.brokkrEnvPins == filePins && config.brokkrEnvPinVars == fileVars;
        message = "brokkrEnvPins/brokkrEnvPinVars may only be set by ./env.local.nix (devenv/scripts/render-env-pins.sh writes it) — a definition anywhere else is read but never applied.";
      }
    ]
    ++ map (e: {
      assertion = false;
      message = "brokkrEnvPins: ${e.var} may not pin '${e.path}' — ${e.refusal}. Unset it to bring the stack up.";
    }) refused;

    envPins = map (e: { inherit (e) path var; }) entries;
    envPinRefusals = lib.sort (a: b: a.path < b.path) (
      lib.concatMap (
        path:
        let
          r = refusalFor path;
        in
        lib.optional (r != null) {
          inherit path;
          reason = r;
        }
      ) (lib.attrNames config.knobMeta)
    );
  } (map (e: lib.setAttrByPath e.targetParts (lib.mkOverride 60 e.value)) entries);
}
