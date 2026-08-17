# Nix mirror of sim/scripts/local/zones.py — zone identity derivations the spoke supervisor
# (modules/spoke.nix) shares with the engine, so both agree on each zone's UUID + each HA
# bridge's port without a shared registry. KEEP IN LOCKSTEP WITH zones.py:
#   - zoneUuid(index)        ↔ zone_uuid(index)        (index 0 == legacy "…111111111111")
#   - withPortBlocks ordering ↔ spoke_port_blocks       (zones by index; bridges contiguous)
# Plain helper (like ports.nix/lib.nix), imported as `(import ./zones.nix { inherit lib; })`.
{ lib }:
rec {
  # zoneUuid(index): the Hub Zone UUID / Redis prefix for a 0-based zone index. n = 11 + index
  # keeps index 0 byte-identical to the historical constant; valid for indices 0..88 (n 11..99,
  # always two digits). Mirrors zones.py:zone_uuid.
  zoneUuid =
    index:
    assert lib.assertMsg (index >= 0 && index <= 88) "zone index ${toString index} out of range 0..88";
    "00000000-0000-0000-0000-1111111111${toString (11 + index)}";

  # Annotate each zone with a contiguous global spoke-port ordinal: zones sorted by index, each
  # zone's block placed after all lower-index zones' bridges. Bridge b of a zone then binds
  # ports.spoke.base + step*(baseOrdinal + b) (and gRPC likewise) — no cross-zone collision.
  # Mirrors zones.py:spoke_port_blocks. `zonesList`: [{ name; index; bridges; … }] → same list
  # sorted, each with an added `baseOrdinal`.
  withPortBlocks =
    zonesList:
    (lib.foldl'
      (acc: z: {
        ordinal = acc.ordinal + z.bridges;
        out = acc.out ++ [ (z // { baseOrdinal = acc.ordinal; }) ];
      })
      {
        ordinal = 0;
        out = [ ];
      }
      (lib.sort (a: b: a.index < b.index) zonesList)
    ).out;
}
