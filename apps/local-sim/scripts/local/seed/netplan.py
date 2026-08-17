"""Sim netplan generator. Pure — no DB, no I/O."""

from __future__ import annotations

from local.config import get_settings


def sim_static_netplan(ip: str, gateway: str, data_mac: str, prefix: int) -> str:
    """Match-by-MAC static netplan with ``set-name: eth0``.

    The MAC match survives systemd predictable naming (``enp0sN``); used identically in the discovery
    initrd and the installed-OS cloud-init, both from ``device.netplan`` in Bridge Redis.
    """
    ns = ", ".join(get_settings().sim.nameservers)
    return (
        "network:\n"
        "  version: 2\n"
        "  ethernets:\n"
        "    sim-data:\n"
        f'      match: {{macaddress: "{data_mac}"}}\n'
        "      set-name: eth0\n"
        "      dhcp4: false\n"
        "      dhcp6: false\n"
        f"      addresses: [{ip}/{prefix}]\n"
        "      routes:\n"
        "        - to: 0.0.0.0/0\n"
        f"          via: {gateway}\n"
        "      nameservers:\n"
        f"        addresses: [{ns}]\n"
    )


def sim_dhcp_netplan(data_mac: str) -> str:
    """Match-by-MAC DHCP netplan (guest learns address/gateway/DNS from the reservation).

    Same match-by-MAC + ``set-name: eth0`` shape as ``sim_static_netplan``.
    """
    return (
        "network:\n"
        "  version: 2\n"
        "  ethernets:\n"
        "    sim-data:\n"
        f'      match: {{macaddress: "{data_mac}"}}\n'
        "      set-name: eth0\n"
        "      dhcp4: true\n"
        "      dhcp6: false\n"
    )
