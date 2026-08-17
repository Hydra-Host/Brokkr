# DCIM Module

DCIM (Data Center Infrastructure Management) models the physical infrastructure inside data centers: servers in racks, cables between ports, power distribution, and serial console access. It answers questions like "what's in rack A3?", "what is this server's eth0 plugged into?", and "how much power is PSU-2 drawing?"

## Entities

**Interface** -- A network port on a server. Can be physical (eth0, ib0), a bond/LAG (bond0), a VLAN sub-interface (bond0.100), or a management port (ipmi0). Bonds and VLANs use self-referential relationships: bond members point to their LAG parent via `lagId`, and VLAN sub-interfaces point to their parent interface via `parentId`. Also stores LLDP neighbor discovery data and InfiniBand-specific fields (GUID, port state).

**Rack** -- A physical server rack in a data center zone, typically 42U tall. Has a status lifecycle (planned, active, reserved, decommissioned) and an optional role (compute, network, storage, etc.). Unique per zone by name.

**DeviceRackAssignment** -- Places a device at a specific U position and face (front/rear) in a rack. Positions use `Decimal` to support half-U devices (e.g., position 10.5). Each device can only be in one rack, and each position+face combination in a rack is unique.

**Cable** -- A physical cable connecting two endpoints. Describes the media type (Cat6A, fiber OM4, DAC, power, serial, etc.), length, color, and status. Always has exactly two terminations -- an A-side and a B-side.

**CableTermination** -- One end of a cable. Uses a polymorphic pattern: `terminationType` says what kind of port it connects to (interface, console port, power port, etc.) and `terminationId` points to that port's UUID. The unique constraint on `[cableId, cableSide]` enforces exactly one A and one B per cable, and the unique constraint on `[terminationType, terminationId]` enforces that a port hosts at most one cable end.

**ConsolePort** -- A serial console port on a server (e.g., ttyS0, a DE-9 connector, or a USB port). Used for out-of-band management when network access is down.

**ConsoleServerPort** -- A port on a console server (the aggregation device that collects serial connections from many servers into one management point). Cabled to individual server ConsolePorts.

**PowerPort** -- A PSU input on a device (e.g., PSU-1, PSU-2). Tracks `maximumDraw` (what the PSU can handle) and `allocatedDraw` (what it's expected to consume) in watts. Receives power from a PDU PowerOutlet via cable.

**PowerOutlet** -- An output port on a PDU (Power Distribution Unit). Feeds power to device PowerPorts. Tracks the electrical feed leg phase (A/B/C) for three-phase power distribution.

**FrontPort / RearPort** -- Patch panel ports. A FrontPort maps through the panel to a RearPort. A single RearPort can serve multiple positions (1:N mapping via `rearPortPosition`), modeling multi-fiber or multi-pair breakout panels.

## Key Relationships

- All port types (Interface, ConsolePort, PowerPort, etc.) belong to a Device.
- Racks belong to a Zone (the backend term for what users see as "data center").
- Cables connect any two port types through the polymorphic CableTermination model. Power flows from PowerOutlet to PowerPort. Network cables connect Interfaces. Serial cables connect ConsoleServerPorts to ConsolePorts.
- FrontPorts always reference a RearPort on the same device, forming the patch-through relationship.

## Ownership

These entities are Brokkr-owned: the Brokkr database is the sole source of truth, managed via admin CRUD. There is no NetBox sync — the `netboxId` columns and the `device-netbox-sync` queue have been removed. The schema shape still echoes NetBox's DCIM module (the system Brokkr replaced), but nothing dual-writes anywhere.
