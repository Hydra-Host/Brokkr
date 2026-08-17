from __future__ import annotations

from pathlib import Path

import yaml

from local.config import get_settings
from local.derived import effective_console_port
from local.render import render_domain
from local.schema import Fleet


def render_fleet_to_dir(
    fleet_path: Path,
    out_dir: Path,
    templates_dir: Path,
    overlay_root: Path,
    console_log_dir: Path | None = None,
) -> Fleet:
    """Render one ``<node>.xml`` per node to ``out_dir/domains/`` (stale XMLs cleared first); returns the Fleet.

    Each domain points at its own ``socket_vmnet.<node>.sock`` — one daemon per VM (avoids Apple
    vmnet.framework HOL blocking).
    """
    s = get_settings()
    if console_log_dir is None:
        console_log_dir = s.state.log_dir
    fleet = Fleet.model_validate(yaml.safe_load(fleet_path.read_text()))
    out_dir.mkdir(parents=True, exist_ok=True)
    domains_dir = out_dir / "domains"
    domains_dir.mkdir(exist_ok=True)

    for stale in domains_dir.glob("*.xml"):
        stale.unlink()

    for i, node in enumerate(fleet.nodes):
        overlay_path = overlay_root / f"{node.name}.img"
        console_log_path = console_log_dir / f"{node.name}.log"
        vmnet_socket_path = s.state.socket_vmnet_sock_for(node.name)
        (domains_dir / f"{node.name}.xml").write_text(
            render_domain(
                fleet,
                node,
                templates_dir,
                overlay_path=str(overlay_path),
                console_log_path=str(console_log_path),
                console_tcp_port=effective_console_port(node, i),
                vmnet_socket_path=str(vmnet_socket_path),
            )
        )

    return fleet
