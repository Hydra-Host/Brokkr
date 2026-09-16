#!/usr/bin/env python
"""Seed bounded historical diagnostics for the first two deterministic sim servers."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from local.derived import sim_device_uuid
from local.sqlemit import header, logs_to_stderr, q, qj

OWNER_EMAIL = "brokkr@brokkr.local"

PRIMARY_DEVICE_TEST_RUNS = 21
SECONDARY_DEVICE_TEST_RUNS = 4


def _timestamp(value: datetime) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _test_run_id(index: int) -> str:
    return f"00000000-0000-4000-8000-{6100 + index:012d}"


def _test_run_data(
    device_index: int,
    run_index: int,
    test_type: str,
    passed: bool,
    started_at: str,
    ended_at: str,
    duration: int,
) -> dict[str, object]:
    data: dict[str, object] = {
        "test_type": test_type,
        "status": "completed",
        "result": "passed" if passed else "failed",
        "deviceId": sim_device_uuid(device_index),
        "jobId": _test_run_id(run_index),
        "timing": {
            "started_at": started_at,
            "completed_at": ended_at,
            "duration_seconds": duration,
        },
    }
    if test_type == "GpuBurnIn":
        data["gpu_metrics"] = {
            "gpu_count": 8,
            "iterations": 180,
            "max_temperature_celsius": 71 + (run_index % 4),
            "average_power_watts": 612 + run_index,
            "throughput_tflops": 928.5 + run_index,
        }
        data["errors"] = (
            [] if passed else [{"code": "XID_79", "message": "GPU 3 fell off the bus during burn-in", "gpu_index": 3}]
        )
    else:
        data["nccl_metrics"] = {
            "algorithm": "Ring",
            "world_size": 8,
            "bus_bandwidth_gbps": 384.2 + run_index,
            "p2p_latency_microseconds": 9.6 + (run_index / 10),
        }
        data["errors"] = (
            [] if passed else [{"code": "NCCL_TIMEOUT", "message": "rank 3 timed out during all-reduce", "rank": 3}]
        )
    return data


def _test_runs() -> tuple[tuple[str, int, str, bool, str, str, int, dict[str, object]], ...]:
    runs: list[tuple[str, int, str, bool, str, str, int, dict[str, object]]] = []
    start = datetime(2026, 7, 1, 9, tzinfo=UTC)
    for device_index, count, offset in ((0, PRIMARY_DEVICE_TEST_RUNS, 0), (1, SECONDARY_DEVICE_TEST_RUNS, 30)):
        for local_index in range(count):
            run_index = offset + local_index
            test_type = "GpuBurnIn" if local_index % 2 == 0 else "NcclPerformance"
            passed = local_index not in {4, 11}
            started_at = _timestamp(start + timedelta(days=run_index))
            duration = 5400 if test_type == "GpuBurnIn" else 720
            ended_at = _timestamp(start + timedelta(days=run_index, seconds=duration))
            runs.append(
                (
                    _test_run_id(run_index),
                    device_index,
                    test_type,
                    passed,
                    started_at,
                    ended_at,
                    duration,
                    _test_run_data(device_index, run_index, test_type, passed, started_at, ended_at, duration),
                )
            )
    return tuple(runs)


DEPLOYMENTS = (
    ("00000000-0000-4000-8000-000000006201", 0, "2026-06-01T00:00:00.000Z", "2026-06-15T00:00:00.000Z"),
    ("00000000-0000-4000-8000-000000006202", 0, "2026-07-01T00:00:00.000Z", "2026-07-14T00:00:00.000Z"),
    ("00000000-0000-4000-8000-000000006203", 1, "2026-07-03T00:00:00.000Z", "2026-07-17T00:00:00.000Z"),
)

DIAGNOSTICS = (
    (
        "00000000-0000-4000-8000-000000006301",
        "00000000-0000-4000-8000-000000006201",
        "Driver",
        "2026-06-14T10:00:00.000Z",
        {"result": "passed", "driverVersion": "570.133.20"},
    ),
    (
        "00000000-0000-4000-8000-000000006302",
        "00000000-0000-4000-8000-000000006202",
        "Thermal",
        "2026-07-13T10:00:00.000Z",
        {
            "result": "failed",
            "errors": [{"code": "THERMAL_LIMIT", "message": "GPU 2 exceeded 85C"}],
            "maxTemperatureCelsius": 89,
        },
    ),
    (
        "00000000-0000-4000-8000-000000006303",
        "00000000-0000-4000-8000-000000006202",
        "Ecc",
        "2026-07-13T10:05:00.000Z",
        {"result": "passed", "correctedErrors": 0, "uncorrectedErrors": 0},
    ),
    (
        "00000000-0000-4000-8000-000000006304",
        "00000000-0000-4000-8000-000000006203",
        "Fabric",
        "2026-07-16T10:00:00.000Z",
        {
            "result": "failed",
            "errors": [{"code": "LINK_DOWN", "message": "mlx5_0 port 1 is down"}],
            "activeLinks": 7,
        },
    ),
)


def generate() -> str:
    out = [
        header("61-device-diagnostics.py"),
        "-- Historical ended deployments only; seeded servers remain in inventory for normal workflows.\n",
        f"-- Device 0 has {PRIMARY_DEVICE_TEST_RUNS} runs so the diagnostics endpoint returns its newest 20.\n",
        "BEGIN;\n",
    ]

    for run_id, device_index, test_type, passed, started_at, ended_at, duration, data in _test_runs():
        device_id = sim_device_uuid(device_index)
        out.append(
            f"""INSERT INTO "DeviceTestRun" (
    id, "deviceId", type, status, "startTime", "endTime", "durationSeconds",
    "testPassed", data, "createdAt", "updatedAt"
)
SELECT
    {q(run_id)}, d.id, {q(test_type)}::"DeviceTestType", 'Completed'::"DeviceTestStatus",
    {q(started_at)}::timestamp, {q(ended_at)}::timestamp, {duration},
    {str(passed).lower()}, {qj(data)}, {q(ended_at)}::timestamp, {q(ended_at)}::timestamp
FROM "Device" d
WHERE d.id = {q(device_id)} AND d.role = 'Server'::"DeviceRole" AND d."deletedAt" IS NULL
ON CONFLICT (id) DO UPDATE SET
    type = EXCLUDED.type, status = EXCLUDED.status, "startTime" = EXCLUDED."startTime",
    "endTime" = EXCLUDED."endTime", "durationSeconds" = EXCLUDED."durationSeconds",
    "testPassed" = EXCLUDED."testPassed", data = EXCLUDED.data,
    "createdAt" = EXCLUDED."createdAt", "updatedAt" = EXCLUDED."updatedAt";"""
        )

    for deployment_id, device_index, start_date, end_date in DEPLOYMENTS:
        device_id = sim_device_uuid(device_index)
        out.append(
            f"""INSERT INTO "Deployment" (
    id, nickname, "startDate", "endDate", type, "serverId", "deployerId",
    "customerId", "createdAt", "updatedAt"
)
SELECT
    {q(deployment_id)}, 'Local sim diagnostics history',
    {q(start_date)}::timestamp, {q(end_date)}::timestamp, 'SELF_SERVICE'::"DeploymentType",
    s.id, u.id, d."supplierId", {q(start_date)}::timestamp, {q(end_date)}::timestamp
FROM "Server" s
JOIN "Device" d ON d.id = s."deviceId"
JOIN "User" u ON u.email = {q(OWNER_EMAIL)}
WHERE d.id = {q(device_id)} AND d.role = 'Server'::"DeviceRole" AND d."deletedAt" IS NULL
ON CONFLICT (id) DO UPDATE SET
    nickname = EXCLUDED.nickname, "startDate" = EXCLUDED."startDate", "endDate" = EXCLUDED."endDate",
    type = EXCLUDED.type, "serverId" = EXCLUDED."serverId", "deployerId" = EXCLUDED."deployerId",
    "customerId" = EXCLUDED."customerId", "createdAt" = EXCLUDED."createdAt",
    "updatedAt" = EXCLUDED."updatedAt";"""
        )

    for diagnostic_id, deployment_id, diagnostic_type, created_at, data in DIAGNOSTICS:
        out.append(
            f"""INSERT INTO "DeviceDiagnostics" (
    id, "deploymentId", type, data, "createdAt", "updatedAt"
)
SELECT
    {q(diagnostic_id)}, d.id, {q(diagnostic_type)}::"DeviceDiagnosticsType",
    {qj(data)}, {q(created_at)}::timestamp, {q(created_at)}::timestamp
FROM "Deployment" d
WHERE d.id = {q(deployment_id)}
ON CONFLICT (id) DO UPDATE SET
    "deploymentId" = EXCLUDED."deploymentId", type = EXCLUDED.type, data = EXCLUDED.data,
    "createdAt" = EXCLUDED."createdAt", "updatedAt" = EXCLUDED."updatedAt";"""
        )

    out.append("COMMIT;")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    logs_to_stderr()
    print(generate(), end="")
