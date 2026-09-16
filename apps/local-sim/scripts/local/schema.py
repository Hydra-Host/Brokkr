from __future__ import annotations

import ipaddress
import re
from functools import cached_property
from pathlib import Path
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from local.derived import bmc_ip, console_tcp_port, node_ip
from local.zones import zone_name

MAC_RE = re.compile(r"^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$")
# host PCI address, e.g. 0000:01:00.0
PCI_RE = re.compile(r"^[0-9a-fA-F]{4}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.[0-7]$")
# Node name: concatenated unescaped into filesystem paths, iPXE scripts, libvirt XML, and a root
# `rm -rf <store>/<name>` — so exclude path separators, `..`, whitespace, shell/XML metacharacters.
NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]*\Z")
NAME_MAX_LEN = 64
IFACE_RE = re.compile(r"^[a-zA-Z0-9._-]{1,15}\Z")
# BMC creds are interpolated inside double quotes into the ipmi_sim lan.conf (daemons.start_ipmi_sim)
BMC_CRED_RE = re.compile(r"^[A-Za-z0-9._-]{1,32}\Z")
# qemu NIC device models we expose in the fleet builder.
NIC_MODELS = ("virtio", "e1000e", "e1000", "rtl8139", "vmxnet3")


def _validate_node_name(v: str) -> str:
    if len(v) > NAME_MAX_LEN:
        raise ValueError(f"node name too long (max {NAME_MAX_LEN}): {v!r}")
    if not NAME_RE.match(v):
        raise ValueError(
            f"invalid node name {v!r}: must match {NAME_RE.pattern} "
            "(alphanumeric start; only letters, digits, '.', '_', '-' — no slashes, "
            "'..', whitespace, or shell/XML metacharacters)"
        )
    return v


def _validate_ipv4(v: str) -> str:
    try:
        ipaddress.IPv4Address(v)
    except ValueError as e:
        raise ValueError(f"invalid IPv4 address: {v!r}") from e
    return v


def _normalize_network_type(v: object) -> object:
    """Accept any case/padding for ``network_type`` and treat an empty value as unset."""
    if not v:
        return None
    return v.strip().lower() if isinstance(v, str) else v


class BmcConfig(BaseModel):
    # hide_input_in_errors keeps a rejected credential out of the ValidationError rendering
    model_config = ConfigDict(hide_input_in_errors=True)

    username: str = "admin"
    password: str = "admin"

    @field_validator("username", "password")
    @classmethod
    def _validate_cred(cls, v: str) -> str:
        if not BMC_CRED_RE.match(v):
            raise ValueError(
                "invalid BMC credential: must be 1-32 chars of letters, digits, '.', '_', '-' — "
                "it is interpolated verbatim into the ipmi_sim lan.conf, so quote/shell "
                "metacharacters could break or inject the config"
            )
        return v


class NicSpec(BaseModel):
    """An extra data-plane NIC beyond the primary (``data_mac``) — a plain L2 port on ``br-brokkr``.

    Model is free to vary (the primary stays virtio so iPXE can PXE-boot) and it carries no static IP. Linux-only.
    """

    mac: str
    model: str = "virtio"
    mtu: int | None = None
    link: str = "up"  # up | down

    @field_validator("mac")
    @classmethod
    def _validate_mac(cls, v: str) -> str:
        if not MAC_RE.match(v):
            raise ValueError(f"invalid mac format: {v!r}")
        return v.lower()

    @field_validator("model")
    @classmethod
    def _validate_model(cls, v: str) -> str:
        if v not in NIC_MODELS:
            raise ValueError(f"nic model must be one of {NIC_MODELS}, got {v!r}")
        return v

    @field_validator("link")
    @classmethod
    def _validate_link(cls, v: str) -> str:
        if v not in ("up", "down"):
            raise ValueError(f"nic link must be 'up' or 'down', got {v!r}")
        return v

    @field_validator("mtu")
    @classmethod
    def _validate_mtu(cls, v: int | None) -> int | None:
        if v is not None and not (1280 <= v <= 9000):
            raise ValueError(f"nic mtu must be 1280..9000, got {v}")
        return v


class DiskSpec(BaseModel):
    """An extra data disk beyond the OS disk (``sda``).

    ``ssd``/``hdd`` render as virtio-scsi; ``nvme`` via qemu:commandline (libvirt has no ``bus='nvme'``).
    """

    size_gb: int = 40
    type: str = "ssd"

    @field_validator("type")
    @classmethod
    def _validate_type(cls, v: str) -> str:
        if v not in ("ssd", "hdd", "nvme"):
            raise ValueError(f"disk type must be 'ssd', 'hdd', or 'nvme', got {v!r}")
        return v


def _default_arch() -> str:
    """Default fleet arch = host arch (qemu naming: aarch64 / x86_64); explicit ``arch`` still overrides."""
    from local.host_os import domain_arch

    return domain_arch()


class Defaults(BaseModel):
    """Fleet-wide defaults applied to any node field left unset."""

    cpus: int = 2
    memory_mb: int = 4096
    disk_gb: int = 40
    arch: str = Field(default_factory=_default_arch)
    bmc: BmcConfig = Field(default_factory=BmcConfig)
    disks: list[DiskSpec] = Field(default_factory=list)
    passthrough: list[str] = Field(default_factory=list)


class Network(BaseModel):
    """Network topology for the fleet's two planes.

    ``cidr`` = data plane (VM↔host bridge); ``bmc_cidr`` = BMC OOB plane (host loopback aliases,
    ipmi_sim/sushy bound). ``dhcp`` enables seeded-prefix DHCP (default off; macOS 26+ disables vmnet DHCP).

    ``rendered_netplan`` makes the fleet exercise the hub's netplan renderer instead of the
    hand-written override the seed normally writes. Off, the seed writes ``Server.netplanOverride``
    and the hub skips publishing the netplan atom — the guest's address comes from a static file the
    sim controls end to end. On, the override is not written (so ``NetplanService`` falls through to
    the renderer), the primary prefix gets a real ``Gateway`` row so a default route can resolve, and
    the hub publishes for real. Default off: a renderer bug otherwise costs the fleet its data plane,
    and there is no DHCP on Linux to fall back to.
    """

    name: str
    cidr: str
    domain: str
    bmc_cidr: str
    dhcp: bool = False
    rendered_netplan: bool = False


class ZoneSpec(BaseModel):
    """A zone in the fleet — one spoke-group of HA bridges sharing a Redis prefix.

    ``index`` → the deterministic Zone UUID + per-zone spoke port block; ``bridges`` = HA replica count (≥1).
    Zones are metadata: a node's network identity stays keyed on its flat list position, only
    ``Server.zoneId`` and its serving spoke follow the zone.
    """

    index: int
    name: str
    bridges: int = 1

    @field_validator("index")
    @classmethod
    def _validate_index(cls, v: int) -> int:
        if not 0 <= v <= 88:
            raise ValueError(f"zone index must be 0..88 (see local.zones.zone_uuid), got {v}")
        return v

    @field_validator("bridges")
    @classmethod
    def _validate_bridges(cls, v: int) -> int:
        if v < 1:
            raise ValueError(f"zone bridges must be >= 1, got {v}")
        return v


class NodeRaw(BaseModel):
    """Raw node entry as written in fleet.yml — partial fields allowed.

    Two MACs: ``ipmi_mac`` (BMC NIC, immutable — seeds Redfish UUID + SCSI serial/WWN) and
    ``data_mac`` (customer-facing, reported on virtio-net, matched by bootpd).
    """

    name: str
    ipmi_mac: str
    data_mac: str
    cpus: int | None = None
    memory_mb: int | None = None
    disk_gb: int | None = None
    arch: str | None = None
    bmc: BmcConfig | None = None
    disks: list[DiskSpec] | None = None
    passthrough: list[str] | None = None
    nics: list[NicSpec] | None = None
    data_mtu: int | None = None
    # Optional static IP overrides; None = index-derived (node_ip / bmc_ip).
    ip: str | None = None
    bmc_ip: str | None = None
    # Optional serial-console telnet port override; None = index-derived (console_tcp_port). The
    # default is host-global (9300 + position), so concurrent fleets on one host must pin distinct ports.
    console_port: int | None = None
    # Zone this node belongs to (a declared zone name). None = the fleet's single
    # default zone; required once more than one zone is declared.
    zone: str | None = None
    # false → the seed lands a role=NULL commissioning device (sql-seed/51) instead of a
    # role=Server device + Server row (sql-seed/50). Nothing else in the engine reads it.
    seed_as_server: bool = True
    # Seeded ``Device.networkType``; None = Public (sim data-plane IPs are host-reachable).
    network_type: Literal["nat", "public"] | None = None

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        return _validate_node_name(v)

    @field_validator("network_type", mode="before")
    @classmethod
    def _coerce_network_type(cls, v: object) -> object:
        return _normalize_network_type(v)

    @field_validator("ip", "bmc_ip")
    @classmethod
    def _validate_ip(cls, v: str | None) -> str | None:
        if v is None:
            return v
        try:
            ipaddress.IPv4Address(v)
        except ValueError as e:
            raise ValueError(f"invalid IPv4 address: {v!r}") from e
        return v

    @field_validator("ipmi_mac", "data_mac")
    @classmethod
    def _validate_mac(cls, v: str) -> str:
        if not MAC_RE.match(v):
            raise ValueError(f"invalid mac format: {v!r}")
        return v.lower()

    @field_validator("console_port")
    @classmethod
    def _validate_console_port(cls, v: int | None) -> int | None:
        if v is not None and not 1024 <= v <= 65535:
            raise ValueError(f"console_port must be 1024..65535, got {v}")
        return v

    @field_validator("passthrough")
    @classmethod
    def _validate_pci(cls, v: list[str] | None) -> list[str] | None:
        for addr in v or []:
            if not PCI_RE.match(addr):
                raise ValueError(f"invalid PCI address: {addr!r} (expected e.g. 0000:01:00.0)")
        return v


class Node(BaseModel):
    """Fully-resolved node (defaults applied)."""

    name: str
    ipmi_mac: str
    data_mac: str
    cpus: int
    memory_mb: int
    disk_gb: int
    arch: str
    bmc: BmcConfig
    disks: list[DiskSpec]
    passthrough: list[str]
    nics: list[NicSpec]
    data_mtu: int | None
    ip: str | None
    bmc_ip: str | None
    console_port: int | None
    zone: str  # resolved zone name (defaults applied)
    seed_as_server: bool
    network_type: Literal["nat", "public"] | None

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        # Node is parsed independently (Fleet.nodes builds Node(name=...) directly,
        # not via model_copy of a validated NodeRaw), so it needs its own guard.
        return _validate_node_name(v)


class BareMetalNode(BaseModel):
    name: str
    pxe_mac: str
    bmc_ip: str
    bmc_mac: str
    arch: str | None = None
    zone: str | None = None
    system_id: str | None = None
    network_type: Literal["nat", "public"] | None = None

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        return _validate_node_name(v)

    @field_validator("network_type", mode="before")
    @classmethod
    def _coerce_network_type(cls, v: object) -> object:
        return _normalize_network_type(v)

    @field_validator("pxe_mac", "bmc_mac")
    @classmethod
    def _validate_mac(cls, v: str) -> str:
        if not MAC_RE.match(v):
            raise ValueError(f"invalid mac format: {v!r}")
        return v.lower()

    @field_validator("bmc_ip")
    @classmethod
    def _validate_bmc_ip(cls, v: str) -> str:
        return _validate_ipv4(v)


class BareMetal(BaseModel):
    iface: str
    iface_ip: str
    arch: Literal["amd64", "arm64"] = "amd64"
    nodes: list[BareMetalNode]

    @field_validator("iface")
    @classmethod
    def _validate_iface(cls, v: str) -> str:
        if not IFACE_RE.match(v):
            raise ValueError(f"invalid iface {v!r}: must match {IFACE_RE.pattern}")
        return v

    @field_validator("iface_ip")
    @classmethod
    def _validate_iface_ip(cls, v: str) -> str:
        return _validate_ipv4(v)


class BareMetalNodeResolved(BaseModel):
    name: str
    pxe_mac: str
    bmc_ip: str
    bmc_mac: str
    arch: str
    zone: str
    system_id: str | None
    network_type: Literal["nat", "public"] | None


class Fleet(BaseModel):
    # the root model's hide_input_in_errors governs nested rendering, keeping a bad BMC credential
    # out of Fleet.model_validate errors (BmcConfig's own config applies only when validated directly)
    model_config = ConfigDict(hide_input_in_errors=True)

    network: Network
    defaults: Defaults = Field(default_factory=Defaults)
    nodes_raw: list[NodeRaw] = Field(alias="nodes")
    zones_raw: list[ZoneSpec] | None = Field(default=None, alias="zones")
    baremetal_raw: BareMetal | None = Field(default=None, alias="baremetal")

    @model_validator(mode="after")
    def _check_unique(self) -> Self:
        seen_names: set[str] = set()
        seen_macs: set[str] = set()
        seen_console: dict[int, str] = {}
        for i, n in enumerate(self.nodes_raw):
            if n.name in seen_names:
                raise ValueError(f"duplicate node name: {n.name!r}")
            # Effective (override-or-derived) port, like the IP checks below: an explicit
            # override must not collide with another node's index-derived default either.
            eff_console = n.console_port or console_tcp_port(i)
            if eff_console in seen_console:
                other = seen_console[eff_console]
                raise ValueError(f"node {n.name!r}: console_port {eff_console} collides with node {other!r}")
            seen_console[eff_console] = n.name
            if n.ipmi_mac == n.data_mac:
                raise ValueError(
                    f"node {n.name!r}: ipmi_mac and data_mac must differ "
                    f"(both = {n.ipmi_mac!r}) — they model physically distinct NICs"
                )
            macs = [("ipmi_mac", n.ipmi_mac), ("data_mac", n.data_mac)]
            macs += [(f"nics[{i}]", nic.mac) for i, nic in enumerate(n.nics or [])]
            for which, mac in macs:
                if mac in seen_macs:
                    raise ValueError(f"duplicate mac: {mac!r} ({which} of {n.name!r})")
                seen_macs.add(mac)
            seen_names.add(n.name)

        # Data-plane IPs: an override must land in the data CIDR (not network/gateway/broadcast), and
        # every effective IP (override or index-derived) must be unique — no override/derived collision.
        net = ipaddress.ip_network(self.network.cidr, strict=False)
        reserved = {net.network_address, net.network_address + 1, net.broadcast_address}
        seen_ips: dict[str, str] = {}
        for i, n in enumerate(self.nodes_raw):
            if n.ip is not None:
                addr = ipaddress.ip_address(n.ip)
                if addr not in net:
                    raise ValueError(f"node {n.name!r}: ip {n.ip} is outside the data network {self.network.cidr}")
                if addr in reserved:
                    raise ValueError(f"node {n.name!r}: ip {n.ip} is reserved (network/gateway/broadcast)")
            eff = n.ip or node_ip(self.network.cidr, i)
            if eff in seen_ips:
                raise ValueError(f"node {n.name!r}: data IP {eff} collides with node {seen_ips[eff]!r}")
            seen_ips[eff] = n.name

        # BMC-plane IPs: same checks against bmc_cidr (an override re-binds ipmi_sim
        # at that address on rebuild; the seeded Device.ipmiIpAddress + Hub join follow).
        bmc_net = ipaddress.ip_network(self.network.bmc_cidr, strict=False)
        bmc_reserved = {bmc_net.network_address, bmc_net.network_address + 1, bmc_net.broadcast_address}
        seen_bmc: dict[str, str] = {}
        for i, n in enumerate(self.nodes_raw):
            if n.bmc_ip is not None:
                addr = ipaddress.ip_address(n.bmc_ip)
                if addr not in bmc_net:
                    raise ValueError(
                        f"node {n.name!r}: bmc_ip {n.bmc_ip} is outside the BMC network {self.network.bmc_cidr}"
                    )
                if addr in bmc_reserved:
                    raise ValueError(f"node {n.name!r}: bmc_ip {n.bmc_ip} is reserved (network/gateway/broadcast)")
            eff = n.bmc_ip or bmc_ip(self.network.bmc_cidr, i)
            if eff in seen_bmc:
                raise ValueError(f"node {n.name!r}: BMC IP {eff} collides with node {seen_bmc[eff]!r}")
            seen_bmc[eff] = n.name
        return self

    @model_validator(mode="after")
    def _check_bm(self) -> Self:
        if self.baremetal_raw is None:
            return self
        if self.nodes_raw and self.baremetal_raw.nodes:
            vm_names = {n.name for n in self.nodes_raw}
            vm_bmc = {n.bmc_ip or bmc_ip(self.network.bmc_cidr, i): n.name for i, n in enumerate(self.nodes_raw)}
            for n in self.baremetal_raw.nodes:
                if n.name in vm_names:
                    raise ValueError(f"baremetal node {n.name!r}: name collides with VM node {n.name!r}")
                if n.bmc_ip in vm_bmc:
                    raise ValueError(
                        f"baremetal node {n.name!r}: bmc_ip {n.bmc_ip} collides with VM node {vm_bmc[n.bmc_ip]!r}"
                    )
        seen_names: set[str] = set()
        seen_pxe: set[str] = set()
        seen_bmc_mac: set[str] = set()
        seen_bmc_ip: dict[str, str] = {}
        for n in self.baremetal_raw.nodes:
            if n.name in seen_names:
                raise ValueError(f"duplicate baremetal node name: {n.name!r}")
            seen_names.add(n.name)
            if n.pxe_mac in seen_pxe or n.pxe_mac in seen_bmc_mac:
                raise ValueError(f"duplicate mac: {n.pxe_mac!r} (pxe_mac of {n.name!r})")
            if n.bmc_mac in seen_bmc_mac or n.bmc_mac in seen_pxe:
                raise ValueError(f"duplicate mac: {n.bmc_mac!r} (bmc_mac of {n.name!r})")
            seen_pxe.add(n.pxe_mac)
            seen_bmc_mac.add(n.bmc_mac)
            if n.bmc_ip in seen_bmc_ip:
                raise ValueError(
                    f"baremetal node {n.name!r}: bmc_ip {n.bmc_ip} collides with {seen_bmc_ip[n.bmc_ip]!r}"
                )
            seen_bmc_ip[n.bmc_ip] = n.name
        return self

    @model_validator(mode="after")
    def _check_rendered_netplan(self) -> Self:
        """Refuse the two fleet shapes where ``rendered_netplan`` silently does not do what it says.

        Both fail by *rendering the wildcard DHCP fallback* rather than erroring, so the fleet looks
        like it is exercising the hub's renderer while proving nothing.
        """
        if not self.network.rendered_netplan:
            return self
        zones = self.zones_raw or []
        # Zones share one org and one cidr, so their primary prefixes are identical; the planner
        # treats an equal-length multi-match as ambiguous and resolves none. No DHCP on Linux.
        if len(zones) > 1:
            raise ValueError(
                "network.rendered_netplan is only supported on a single-zone fleet: "
                f"{len(zones)} zones share one org and one cidr ({self.network.cidr}), so the hub "
                "cannot tell their primary prefixes apart and every device would fall back to DHCP"
            )
        # 46-prefixes routes the primary prefix down its DHCP branch (no Gateway row) while
        # 50-devices still clears netplanOverride — so the renderer has nothing to resolve a route
        # from and emits the DHCP fallback, testing nothing.
        if self.network.dhcp:
            raise ValueError(
                "network.rendered_netplan and network.dhcp are mutually exclusive: DHCP mode seeds "
                "the primary prefix for the DHCP server instead of a routable Gateway, so the "
                "renderer would emit the wildcard DHCP fallback rather than a rendered config"
            )
        return self

    @model_validator(mode="after")
    def _check_zones(self) -> Self:
        """Validate zone declarations and that every node references a real zone.

        Zones are optional (omit → one default zone, index 0); once ≥2 are declared each node must name its zone.
        """
        zones = self.zones_raw or []
        seen_idx: set[int] = set()
        seen_name: set[str] = set()
        for z in zones:
            if z.index in seen_idx:
                raise ValueError(f"duplicate zone index: {z.index}")
            if z.name in seen_name:
                raise ValueError(f"duplicate zone name: {z.name!r}")
            seen_idx.add(z.index)
            seen_name.add(z.name)

        names = seen_name or {zone_name(0)}
        multi = len(zones) > 1
        for n in self.nodes_raw:
            if n.zone is None:
                if multi:
                    raise ValueError(f"node {n.name!r}: zone is required when multiple zones are declared")
            elif n.zone not in names:
                raise ValueError(f"node {n.name!r}: zone {n.zone!r} is not a declared zone {sorted(names)}")

        for n in self.baremetal_raw.nodes if self.baremetal_raw else []:
            if n.zone is not None and n.zone not in names:
                raise ValueError(f"baremetal node {n.name!r}: zone {n.zone!r} is not a declared zone {sorted(names)}")
        return self

    @cached_property
    def zones(self) -> list[ZoneSpec]:
        """Declared zones, or the implicit single default zone (index 0)."""
        return self.zones_raw or [ZoneSpec(index=0, name=zone_name(0), bridges=1)]

    def zone_for(self, name: str | None) -> ZoneSpec:
        """The :class:`ZoneSpec` for a node's ``zone`` (None → the default zone)."""
        if name is None:
            return self.zones[0]
        for z in self.zones:
            if z.name == name:
                return z
        raise KeyError(f"no zone named {name!r}")

    def zone_port_ordinal(self, zone_name: str | None) -> int:
        """The spoke-port ordinal of a node's zone (offset from the spoke port base of its HA bridges' block),
        mirroring ``zones.py:spoke_port_blocks``. Single zone → 0 → legacy :8000."""
        from local.zones import spoke_port_blocks

        blocks = spoke_port_blocks([(z.index, z.bridges) for z in self.zones])
        return blocks[self.zone_for(zone_name).index]["base_ordinal"]

    @cached_property
    def nodes(self) -> list[Node]:
        """Return fully-resolved nodes with defaults applied."""
        return [
            Node(
                name=n.name,
                ipmi_mac=n.ipmi_mac,
                data_mac=n.data_mac,
                cpus=n.cpus if n.cpus is not None else self.defaults.cpus,
                memory_mb=n.memory_mb if n.memory_mb is not None else self.defaults.memory_mb,
                disk_gb=n.disk_gb if n.disk_gb is not None else self.defaults.disk_gb,
                arch=n.arch if n.arch is not None else self.defaults.arch,
                bmc=n.bmc if n.bmc is not None else self.defaults.bmc.model_copy(),
                disks=n.disks if n.disks is not None else [d.model_copy() for d in self.defaults.disks],
                passthrough=n.passthrough if n.passthrough is not None else list(self.defaults.passthrough),
                nics=[nic.model_copy() for nic in (n.nics or [])],
                data_mtu=n.data_mtu,
                ip=n.ip,
                bmc_ip=n.bmc_ip,
                console_port=n.console_port,
                zone=self.zone_for(n.zone).name,
                seed_as_server=n.seed_as_server,
                network_type=n.network_type,
            )
            for n in self.nodes_raw
        ]

    @cached_property
    def bm_nodes(self) -> list[BareMetalNodeResolved]:
        bm = self.baremetal_raw
        if bm is None:
            return []
        return [
            BareMetalNodeResolved(
                name=n.name,
                pxe_mac=n.pxe_mac,
                bmc_ip=n.bmc_ip,
                bmc_mac=n.bmc_mac,
                arch=n.arch if n.arch is not None else bm.arch,
                zone=self.zone_for(n.zone).name,
                system_id=n.system_id,
                network_type=n.network_type,
            )
            for n in bm.nodes
        ]

    @property
    def has_vm(self) -> bool:
        return len(self.nodes_raw) > 0

    @property
    def has_bm(self) -> bool:
        return bool(self.bm_nodes)

    @cached_property
    def bm_node_names(self) -> frozenset[str]:
        return frozenset(n.name for n in self.bm_nodes)


def load_fleet() -> Fleet | None:
    """Parse ``fleet.yml`` into a validated :class:`Fleet`; ``None`` if it doesn't exist.

    Lives here rather than in ``local.fleet`` so config-only consumers (the ``sql-seed``
    generators) reach the model without pulling in that module's daemon/DB imports.
    """
    import yaml

    from local.config import get_settings

    path = get_settings().paths.fleet_path
    if not Path(path).exists():
        return None
    with open(path) as f:
        return Fleet.model_validate(yaml.safe_load(f))


def require_fleet() -> Fleet:
    """:func:`load_fleet` for consumers that cannot proceed without a fleet."""
    fleet = load_fleet()
    if fleet is None:
        from local.config import get_settings

        raise RuntimeError(f"no fleet.yml at {get_settings().paths.fleet_path}")
    return fleet
