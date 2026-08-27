"""Single source of truth for env-driven config + install layout."""

from __future__ import annotations

import os
import platform
import sys
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Final, Literal

from pydantic import BeforeValidator, Field, computed_field
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


def _csv_to_tuple(value: object) -> object:
    """Accept a comma-separated string or a sequence. pydantic-settings parses
    complex types as JSON, but `.env` users expect CSV."""
    if isinstance(value, str):
        return tuple(s.strip() for s in value.split(",") if s.strip())
    return value


def _expand_path(value: object) -> object:
    """Expand a leading ~ or $HOME/$VAR in path env vars — devenv's dotenv loads them verbatim
    and shell consumers expand at use-site, so match that or the engine gets a literal ~/... dir."""
    if isinstance(value, str):
        return Path(os.path.expandvars(value)).expanduser()
    return value


def _detect_host_arch() -> str:
    """Map ``platform.machine()`` to LayerArtifact.arch: arm64/aarch64 → ``arm64``, else ``amd64``."""
    m = platform.machine().lower()
    if m in ("arm64", "aarch64"):
        return "arm64"
    return "amd64"


REPO: Final = Path(__file__).resolve().parents[2]


def _default_fleet_path() -> Path:
    """Fallback fleet config when ``LOCAL_FLEET_PATH`` is unset (the devenv shell sets it to a
    Nix-rendered fleet.yml, honored above this): a gitignored ``fleet.local.yml``, else ``fleet.yml``."""
    local = REPO / "fleet.local.yml"
    return local if local.exists() else REPO / "fleet.yml"


def _detect_libvirt_uri() -> str:
    """Lazy adapter to ``local.host_os.libvirt_uri``."""
    from local.host_os import libvirt_uri

    return libvirt_uri()


def _detect(kind: Literal["qemu", "edk2_code", "edk2_vars"]) -> Path:
    """Lazy adapter to ``local.host_os.detect_*`` — lazy import so config.py imports cleanly on
    hosts lacking the binary (tests can still import + monkeypatch the fields)."""
    from local.host_os import detect_edk2_code, detect_edk2_vars_template, detect_qemu_emulator

    return {
        "qemu": detect_qemu_emulator,
        "edk2_code": detect_edk2_code,
        "edk2_vars": detect_edk2_vars_template,
    }[kind]()


def _config(**extra) -> SettingsConfigDict:
    """Shared config knobs for every sub-model. Each needs its own `env_file` (pydantic-settings
    doesn't propagate the parent's to nested models); `use_attribute_docstrings=True` turns each
    field's attribute docstring into its `description`."""
    return SettingsConfigDict(
        env_file=str(REPO / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        use_attribute_docstrings=True,
        **extra,
    )


class StateSettings(BaseSettings):
    """Per-host state directory and everything derived from it. Override `root` (via LOCAL_STATE)
    to relocate the whole tree."""

    model_config = _config()

    root: Annotated[
        Path,
        BeforeValidator(_expand_path),
        Field(
            default_factory=lambda: Path.home() / ".local/share/local",
            validation_alias="LOCAL_STATE",
        ),
    ]
    """Per-host state root for all boot artifacts, overlays, rendered XMLs,
    pidfiles, NVRAM, and wipe memos."""

    @computed_field
    @property
    def boot_artifact_root(self) -> Path:
        return self.root / "boot"

    @computed_field
    @property
    def iso_cache_root(self) -> Path:
        return self.root / "cache"

    @computed_field
    @property
    def overlay_root(self) -> Path:
        return self.root / "disks/overlays"

    @computed_field
    @property
    def render_dir(self) -> Path:
        return self.root / "state/rendered"

    @computed_field
    @property
    def run_dir(self) -> Path:
        return self.root / "state/run"

    @computed_field
    @property
    def log_dir(self) -> Path:
        return self.root / "state/logs"

    @computed_field
    @property
    def auth_keys_file(self) -> Path:
        return self.root / "cache/authorized_keys"

    @computed_field
    @property
    def nvram_root(self) -> Path:
        return self.root / "nvram"

    def socket_vmnet_sock_for(self, node: str) -> Path:
        return self.run_dir / f"socket_vmnet.{node}.sock"

    def socket_vmnet_pid_for(self, node: str) -> Path:
        return self.run_dir / f"socket_vmnet.{node}.pid"

    def socket_vmnet_log_for(self, node: str) -> Path:
        return self.log_dir / f"socket_vmnet.{node}.log"

    def ipmi_sim_dir_for(self, node: str) -> Path:
        return self.root / "state/ipmi-sim" / node

    @computed_field
    @property
    def sushy_conf_dir(self) -> Path:
        return self.run_dir / "sushy"

    @computed_field
    @property
    def sushy_log_dir(self) -> Path:
        return self.log_dir / "sushy"


class PathsSettings(BaseSettings):
    """Overrideable install-layout + binary + firmware paths, plus non-path build/toolchain knobs
    (`LOCAL_` prefix). Defaults derive from REPO or the host layout; override via env."""

    model_config = _config(env_prefix="LOCAL_")

    templates_dir: Annotated[Path, Field(default=REPO / "templates")]
    # LOCAL_FLEET_PATH (the devenv-rendered fleet.yml) wins inside the shell; else the
    # _default_fleet_path fallback (fleet.local.yml). See _default_fleet_path.
    fleet_path: Annotated[Path, Field(default_factory=_default_fleet_path)]

    python_bin: Annotated[Path, Field(default=Path(sys.prefix) / "bin")]
    """Python environment bin dir. Defaults to the active interpreter's prefix
    (the devenv `pythonEnv` store path inside `devenv shell`); drives the `sushy`
    computed field. Override via `LOCAL_PYTHON_BIN`."""

    libvirt_uri: Annotated[
        str,
        Field(default_factory=lambda: _detect_libvirt_uri()),
    ]
    """User-facing libvirt URI. macOS uses the user-session virtqemud socket;
    Linux uses ``qemu:///system``. ipmi_sim's root chassis hook uses
    daemons.libvirt_uri_for_root, which adapts similarly."""

    edk2_code_path: Annotated[
        Path,
        Field(default_factory=lambda: _detect("edk2_code")),
    ]
    """EDK2 UEFI firmware code, loaded passively alongside direct-kernel boot
    so /sys/firmware/efi appears inside the guest. Auto-detected; override via
    LOCAL_EDK2_CODE_PATH."""

    edk2_vars_template_path: Annotated[
        Path,
        Field(default_factory=lambda: _detect("edk2_vars")),
    ]
    socket_vmnet_bin: Annotated[
        Path,
        Field(default=Path("/opt/socket_vmnet/bin/socket_vmnet")),
    ]
    """socket_vmnet binary. Only consulted on macOS; Linux uses libvirt's
    native bridge network instead."""

    qemu_emulator: Annotated[
        Path,
        Field(default_factory=lambda: _detect("qemu")),
    ]
    """qemu binary baked into rendered libvirt XMLs as `<emulator>`.
    Auto-detected per host arch; override via LOCAL_QEMU_EMULATOR for
    alternate builds."""

    build_base_image: Annotated[str, Field(default="ubuntu:24.04")]
    """Docker base image for the local-sim iPXE + GRUB builds (pxe.py /
    grub_build.py). Single source of truth; override via LOCAL_BUILD_BASE_IMAGE."""

    data_bridge: Annotated[str, Field(default="br-brokkr")]
    """Name of the Linux flat-L2 data-plane kernel bridge (created by fleet.py's
    ensure_data_plane_bridge; baked into each domain's <interface><source bridge=>)."""

    accel: Annotated[Literal["auto", "kvm", "tcg", "hvf"], Field(default="auto")]
    """Force one qemu accelerator, or auto-detect. Never a probing default_factory —
    the probe reads get_settings(), which is lru_cached and not re-entrant."""

    ipmi_sim: Annotated[
        Path,
        Field(default=Path("/opt/openipmi/bin/ipmi_sim"), validation_alias="LOCAL_IPMI_SIM_BIN"),
    ]
    """OpenIPMI lanserv ipmi_sim binary — the BMC plane, sudo-launched by absolute
    path (daemons.start_ipmi_sim). From the openipmi Nix package (devenv.nix sets
    LOCAL_IPMI_SIM_BIN); the default here is the out-of-devenv fallback."""

    sim_priv_bin: Annotated[
        Path,
        Field(default=Path("/opt/brokkr-sim-priv/bin/brokkr-sim-priv"), validation_alias="LOCAL_SIM_PRIV_BIN"),
    ]
    """The privileged sim helper (brokkr-sim-priv), sudo-run as the single root entry point
    for the fleet's scoped privileged ops (process_utils.sudo_priv). From the sim-priv Nix
    package (devenv.nix sets LOCAL_SIM_PRIV_BIN); the default here is the out-of-devenv fallback."""

    @computed_field
    @property
    def sushy(self) -> Path:
        return self.python_bin / "sushy-emulator"


class BridgeSettings(BaseSettings):
    """Local bridge endpoint and bridge-side persistent storage. Bridge always runs on the same
    Mac at ``http://127.0.0.1:8000`` (no remote-bridge mode)."""

    model_config = _config(env_prefix="BRIDGE_")

    endpoint: Annotated[str, Field(default="http://127.0.0.1:8000")]
    """Base URL the sim fetches boot artifacts from. Override via
    ``BRIDGE_ENDPOINT`` only for non-default ports / container networks. iPXE
    rewrites ``127.0.0.1`` → data-plane gateway IP at build time, since the VM's
    localhost is not the Mac's (see ``pxe._vm_reachable_bridge_url``)."""

    zone_id: Annotated[str, Field(default="00000000-0000-0000-0000-111111111111")]
    """Zone UUID for Bridge Redis key namespacing AND ``Zone.id`` in Hub
    Postgres. Override via ``BRIDGE_ZONE_ID`` to run multiple sim fleets on
    one host."""

    api_repo: Annotated[
        Path,
        BeforeValidator(_expand_path),
        Field(
            default_factory=lambda: Path(__file__).resolve().parents[4],
            validation_alias="HUB_REPO_PATH",
        ),
    ]
    """brokkr-app monorepo checkout — used to cpio-pack brokkr-live.img from apps/bridge/boot/initrd-live.
    Defaults to the checkout this file lives in (scripts/local/config.py → parents[4] is the repo root),
    so it's correct for any clone path; override with ``HUB_REPO_PATH``."""

    persistent_storage: Annotated[Path, Field(default=Path("/tmp/brokkr-dev"))]
    """Where local bridge serves initrd builds from (its
    PERSISTENT_STORAGE_PATH)."""

    ssh_key_path: Annotated[
        Path,
        Field(default_factory=lambda: Path.home() / ".config/bridge-api/ssh-key.pub"),
    ]
    """bridge-api's SSH public key, staged into the cpio overlay by
    initrd.stage_authorized_keys so root SSH from bridge into sims works."""

    @computed_field
    @property
    def initrd_builds_dir(self) -> Path:
        return self.persistent_storage / "initrd-builds"

    @computed_field
    @property
    def brokkr_live_img(self) -> Path:
        return self.initrd_builds_dir / "brokkr-live.img"

    @computed_field
    @property
    def bridge_agent_img(self) -> Path:
        return self.initrd_builds_dir / "bridge-agent.img"


class HubSettings(BaseSettings):
    """Hub main-API endpoint (the customer/saga API, ``main.ts``)."""

    model_config = _config(env_prefix="HUB_")

    endpoint: Annotated[str, Field(default="http://127.0.0.1:3000")]
    """Base URL of the Hub main API. Override via ``HUB_ENDPOINT`` (the devenv
    stack scales hubs at 3000 + 2i)."""


class SimSettings(BaseSettings):
    """Sim-bootstrap values consumed by the ``sql-seed`` generators. SIM_ORG_TENANT_ID is a lookup
    key for an existing Organization; the sim zone is upserted under it so the admin user sees it."""

    model_config = _config(env_prefix="SIM_")

    slot: Annotated[int, Field(default=0, ge=0, le=46)]
    """Multi-stack instance slot (``SIM_SLOT``, exported by the devenv env block from
    ``config.stack.slot``). Drives the per-slot namespacing of host-global resources:
    the bootptab section marker and the libvirt domain managed-tag. 0 = legacy layout."""

    zone_name: Annotated[str, Field(default="sim-zone")]
    netbox_site_id: Annotated[int, Field(default=1)]
    netbox_location_id: Annotated[int, Field(default=1)]

    zone_count: Annotated[int, Field(default=1, ge=1, le=89)]
    """DEPRECATED (``SIM_ZONE_COUNT``): zone topology comes from ``Fleet.zones``, and this is kept
    only so the env var still parses."""

    org_tenant_id: Annotated[str, Field(default="1")]
    """Tenant id on the Hydra Host org (``Organization.tenantId``)."""

    hydrahost_org_id: Annotated[str, Field(default="00000000-0000-0000-0000-000000000000")]
    """Static ``Organization.id`` the ``45-zone`` generator FK-references (created
    by Hub's main.admin.ts bootstrap). Matches brokkr-app's
    ``HYDRAHOST_ORGANIZATION_ID`` so saga payloads reference an existing org."""

    hydrahost_org_name: Annotated[str, Field(default="Brokkr Org")]

    @computed_field
    @property
    def owner_emails(self) -> tuple[str, ...]:
        """Sim admin email; matches Hub's main.admin.ts bootstrap. The ``30-ssh-keys`` generator
        attaches ~/.ssh/*.pub to this user."""
        return ("brokkr@brokkr.local",)

    os_layers_manifest_index_url: Annotated[
        str,
        Field(default="https://brokkr.assets.hydra.host/os-layers/releases/latest"),
    ]
    """JSON index pointing at the current OS-layers manifest. ``local.seed.os_catalog.fetch_manifest``
    follows its ``url`` to the versioned manifest and writes
    LayerGroup/Layer/LayerArtifact rows via psycopg. Under the devenv
    stack ``SIM_OS_LAYERS_MANIFEST_INDEX_URL`` is set from the Nix knob
    osLayerCache.originHost; this default is the standalone-Python fallback. Override
    via the env var or the knob."""

    host_arch: Annotated[
        Literal["arm64", "amd64"],
        Field(default_factory=_detect_host_arch, validation_alias="SIM_HOST_ARCH"),
    ]
    """Architecture stamped onto every seeded ``Device.architecture`` so the
    OS-layer resolver picks the matching ``LayerArtifact.arch``. Auto-detected;
    override via ``SIM_HOST_ARCH``."""

    bridge_name: Annotated[str, Field(default="sim-bridge")]
    """Device name representing the local Mac bridge in Bridge Redis."""

    redfish_port: Annotated[int, Field(default=8443, validation_alias="SIM_REDFISH_PORT")]
    """Port sushy-emulator binds on each BMC IP for Redfish. Kept off the spoke's
    :8000 to avoid collision when the spoke binds 0.0.0.0 (Linux)."""

    nameservers: Annotated[
        tuple[str, ...],
        NoDecode,
        BeforeValidator(_csv_to_tuple),
        Field(default=("1.1.1.1", "8.8.8.8")),
    ]
    """DNS resolvers baked into the sim netplan. The data-plane gateway (the Mac
    itself) runs no resolver, so sims must hit public DNS directly. Override via
    env as a comma-separated list, e.g. `SIM_NAMESERVERS=9.9.9.9,1.0.0.1`."""


class StoresSettings(BaseSettings):
    """Both data stores live here — Hub Postgres and Bridge Redis."""

    model_config = _config()

    hub_database_url: Annotated[
        str,
        Field(
            default="postgresql://brokkr:password@localhost:5432/brokkr",
            validation_alias="HUB_DATABASE_URL",
        ),
    ]
    bridge_redis_url: Annotated[
        str,
        Field(
            default="redis://127.0.0.1:6379",
            validation_alias="BRIDGE_REDIS_URL",
        ),
    ]


class RuntimeSettings(BaseSettings):
    """Misc runtime knobs that don't belong with paths, bridge, sim, or stores."""

    model_config = _config()

    cache_ttl_seconds: Annotated[
        int,
        Field(default=86400, validation_alias="CACHE_TTL_SECONDS"),
    ]
    """TTL for Bridge Redis device-record cache entries. Defaults to 24h."""


class Settings(BaseSettings):
    """Root settings model — composes the per-domain sub-models above."""

    model_config = _config()

    paths: Annotated[PathsSettings, Field(default_factory=lambda: PathsSettings())]
    state: Annotated[StateSettings, Field(default_factory=lambda: StateSettings())]
    bridge: Annotated[BridgeSettings, Field(default_factory=lambda: BridgeSettings())]
    hub: Annotated[HubSettings, Field(default_factory=lambda: HubSettings())]
    sim: Annotated[SimSettings, Field(default_factory=lambda: SimSettings())]
    stores: Annotated[StoresSettings, Field(default_factory=lambda: StoresSettings())]
    runtime: Annotated[RuntimeSettings, Field(default_factory=lambda: RuntimeSettings())]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
