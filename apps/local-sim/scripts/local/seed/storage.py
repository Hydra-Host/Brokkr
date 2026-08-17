"""Storage-layouts JSON shape. Pure — same value goes to Bridge Redis
(``custom_fields.storage_layouts``) AND Hub Postgres (``Device.storageLayouts``)."""

from __future__ import annotations

from local.derived import node_serial, node_wwn


def build_storage_layouts(ipmi_mac: str, disk_gb: int) -> dict:
    """Single source of truth for the disk shape bridge consumes.

    Bridge correlates ``lsblk -o NAME,SERIAL,WWN`` against ``configs[].disks[]``
    by serial/WWN, so values MUST match qemu's SCSI INQUIRY (same ``ipmi_mac``).
    """
    disk_group = f"SIM_SSD_{disk_gb}GB"
    return {
        "configs": [
            {
                "disk_group_name": disk_group,
                "disk_type": "ssd",
                "disks": [
                    {
                        "name": "sda",
                        "serial": node_serial(ipmi_mac),
                        "wwn": node_wwn(ipmi_mac),
                    },
                ],
                "num_disks": 1,
                "size_per_disk": disk_gb * 1024 * 1024 * 1024,
                "capabilities": ["direct", "lvm"],
                "file_systems": ["ext4", "xfs"],
            },
        ],
        "default": {
            "os_disks_group": {
                "group": disk_group,
                "config": "lvm",
                "file_system": "ext4",
                "mountpoint": "/",
            },
            "data_disks_groups": [],
            "cold_storage_disks_groups": [],
        },
    }
