#!/usr/bin/env python
"""Seed a few sample DeviceDocument rows for the admin Documents tab."""

from __future__ import annotations

from local.derived import sim_device_uuid
from local.sqlemit import header, logs_to_stderr, q

OWNER_EMAIL = "brokkr@brokkr.local"

# (id, device_index, name, file_url, file_type, description)
DOCUMENTS = (
    (
        "00000000-0000-4000-8000-000000006401",
        0,
        "Rack layout",
        "https://example.com/sim/rack-layout.pdf",
        "application/pdf",
        "Sample rack PDF for the admin Documents tab",
    ),
    (
        "00000000-0000-4000-8000-000000006402",
        0,
        "Warranty certificate",
        "https://example.com/sim/warranty.pdf",
        "application/pdf",
        "Manufacturer warranty placeholder",
    ),
    (
        "00000000-0000-4000-8000-000000006403",
        0,
        "BMC credential sheet",
        "https://example.com/sim/bmc-creds.png",
        "image/png",
        None,
    ),
    (
        "00000000-0000-4000-8000-000000006404",
        1,
        "Delivery packing slip",
        "https://example.com/sim/packing-slip.pdf",
        "application/pdf",
        "Second-server sample attachment",
    ),
)


def generate() -> str:
    out = [
        header("62-device-documents.py"),
        "-- Sample documents on the first two sim servers for the admin Documents tab.\n",
        "BEGIN;\n",
    ]

    for doc_id, device_index, name, file_url, file_type, description in DOCUMENTS:
        device_id = sim_device_uuid(device_index)
        description_sql = "NULL" if description is None else q(description)
        out.append(
            f"""INSERT INTO "DeviceDocument" (
    id, name, "fileUrl", "fileType", description, "deviceId", "uploadedById", "createdAt", "updatedAt"
)
SELECT
    {q(doc_id)}, {q(name)}, {q(file_url)}, {q(file_type)}, {description_sql},
    d.id, u.id, NOW(), NOW()
FROM "Device" d
JOIN "User" u ON u.email = {q(OWNER_EMAIL)}
WHERE d.id = {q(device_id)} AND d.role = 'Server'::"DeviceRole" AND d."deletedAt" IS NULL
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, "fileUrl" = EXCLUDED."fileUrl", "fileType" = EXCLUDED."fileType",
    description = EXCLUDED.description, "deviceId" = EXCLUDED."deviceId",
    "uploadedById" = EXCLUDED."uploadedById", "updatedAt" = EXCLUDED."updatedAt";"""
        )

    out.append("COMMIT;")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    logs_to_stderr()
    print(generate(), end="")
