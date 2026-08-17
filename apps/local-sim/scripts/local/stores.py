"""Hub Postgres read client — the read helpers used by fleet orchestration (``fleet.py``)."""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass

import psycopg

from local.config import get_settings


@dataclass(frozen=True)
class SimDevice:
    id: str
    name: str
    zone_id: str
    ipmi_ip: str
    primary_ip: str | None


class HubDB:
    def __init__(self, dsn: str):
        self.dsn = dsn

    @classmethod
    def from_env(cls) -> HubDB:
        return cls(get_settings().stores.hub_database_url)

    @contextmanager
    def _conn(self) -> Iterator[psycopg.Connection]:
        with psycopg.connect(self.dsn) as conn:
            yield conn

    def get_sim_devices_by_bmc_ips(self, bmc_ips: list[str]) -> list[SimDevice]:
        """Join fleet BMC IPs → hub ``Device`` identity.

        The ``deletedAt IS NULL`` pins are load-bearing: ``(deviceId, name)`` on ``Interface`` is
        unique only among active rows (partial index), so a tombstoned IPMI/eth0 row would otherwise
        resolve a node to the wrong device. They stay in the ON clauses — moving them to WHERE would
        degrade the eth0 LEFT JOINs into inner joins and drop BMC-only nodes from the result."""
        if not bmc_ips:
            return []
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT d.id, d.name, d."zoneId", host(ipmi.address), host(eth.address)
                FROM "Device" d
                JOIN "Interface" ii
                    ON ii."deviceId" = d.id AND ii.name = 'IPMI' AND ii."deletedAt" IS NULL
                JOIN "IpAddress" ipmi
                    ON ipmi."interfaceId" = ii.id AND ipmi."deletedAt" IS NULL
                LEFT JOIN "Interface" ei
                    ON ei."deviceId" = d.id AND ei.name = 'eth0' AND ei."deletedAt" IS NULL
                LEFT JOIN "IpAddress" eth
                    ON eth."interfaceId" = ei.id AND eth."deletedAt" IS NULL
                WHERE host(ipmi.address) = ANY(%s)
                """,
                (bmc_ips,),
            )
            return [
                SimDevice(
                    id=row[0],
                    name=row[1],
                    zone_id=row[2] or "",
                    ipmi_ip=row[3],
                    primary_ip=row[4],
                )
                for row in cur.fetchall()
            ]

    def get_server_state(self, device_id: str) -> tuple[str | None, str | None]:
        """Return ``(Server.lifecycleStatus, Device.status)`` — the two lifecycle
        axes the provision/deprovision sagas drive. ``(None, None)`` if absent."""
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(
                'SELECT s."lifecycleStatus", d.status FROM "Device" d '
                'LEFT JOIN "Server" s ON s."deviceId" = d.id WHERE d.id = %s',
                (device_id,),
            )
            row = cur.fetchone()
            return (row[0], row[1]) if row else (None, None)

    def get_storage_layouts(self, device_id: str) -> dict | None:
        """Read ``Server.storageLayouts`` — the seeded disk catalog a provision
        request's ``diskLayouts`` must agree with."""
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute('SELECT "storageLayouts" FROM "Server" WHERE "deviceId" = %s', (device_id,))
            row = cur.fetchone()
            if not row or not row[0]:
                return None
            return row[0] if isinstance(row[0], dict) else json.loads(row[0])
