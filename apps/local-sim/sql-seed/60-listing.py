#!/usr/bin/env python
"""Generator: marketplace listing → SQL.

Sets pricing + ``isListed`` on every sim ``Server`` (``Device.role = 'Server'``; bridges excluded).
Numbering (60) applies after ``50-devices``.
"""

from __future__ import annotations

from local.sqlemit import header, logs_to_stderr

HOURLY_PRICE = "1.0000"
FLOOR_HOURLY_PRICE = "0.5000"


def generate() -> str:
    return "".join(
        [
            header("60-listing.py"),
            "BEGIN;\n\n",
            f"""-- pricing + isListed on every sim Server
UPDATE "Server"
SET "hourlyPrice" = {HOURLY_PRICE}, "floorHourlyPrice" = {FLOOR_HOURLY_PRICE},
    "isListed" = TRUE, "updatedAt" = NOW()
WHERE "deviceId" IN (SELECT id FROM "Device" WHERE role = 'Server'::"DeviceRole");

COMMIT;
""",
        ]
    )


if __name__ == "__main__":
    logs_to_stderr()
    print(generate(), end="")
