# Per-slot host paths for the spoke: persistent storage + the staged agent bundle dir.
# Slot 0 keeps the legacy paths (byte-parity, pre-existing state reused); slots >=1 get
# suffixed trees so concurrent stacks never share them. Exposed as a plain function (like
# ports.nix `forSlot`) so the bats suite can exercise the derivation without a full config eval.
{
  forSlot = slot: {
    storage = if slot == 0 then "/tmp/brokkr-dev" else "/tmp/brokkr-dev-s${toString slot}";
    agent = if slot == 0 then "/opt/brokkr/agent" else "/opt/brokkr/agent-s${toString slot}";
  };
}
