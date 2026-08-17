from __future__ import annotations

import re
from pathlib import Path

from local.prisma_schema import hub_prisma_schema, quoted_sql_identifiers, sql_schema_violations

_APPS = Path(__file__).resolve().parents[2]
PY_RESET = _APPS / "local-sim" / "scripts" / "local" / "reset_device.py"
TS_RESET = _APPS / "local-lab" / "src" / "fleet" / "fleet-reset.service.ts"
TS_SAGA_TOPOLOGY = _APPS / "local-lab" / "src" / "queues" / "saga-topology.ts"

_PY_TOP_LEVEL = r"(?=^(?:def |class |@|#|[A-Za-z_]))"
_BAREMETAL_BRANCH = "\n    if bm:"

_PY_SAGA_CONST = re.compile(r"^_SAGA_(\w+)\s*=\s*\(([^)]*)\)", re.M)
_TS_TOPOLOGY_ARRAY = re.compile(r"export const (\w+)(?:\s*:[^=]+)?\s*=\s*\[([^\]]*)\]")
_TS_TOPOLOGY_STRING = re.compile(r"export const (\w+)\s*=\s*'([^']*)'")
_TS_QUEUE_KEY_CALL = re.compile(r"queueKey\(\s*(\w+),\s*'([^']+)',\s*`([^`]*)`")
_LITERAL_MEMBER = re.compile(r"""['"]([^'"]+)['"]""")
_PY_FSTRING = re.compile(r'f"([^"]*)"')
_TS_TEMPLATE = re.compile(r"`([^`]*)`")
_PY_PLACEHOLDER = re.compile(r"\{[^}]*\}")
_TS_PLACEHOLDER = re.compile(r"\$\{[^}]*\}")

_SAGA_CONST_NAMES = {"QUEUES", "QUEUE_LISTS", "QUEUE_ZSETS", "QUEUE_SETS"}
_TS_TOPOLOGY_CONST_NAMES = {
    "QUEUES": "SAGA_QUEUE_NAMES",
    "QUEUE_LISTS": "QUEUE_LIST_STATES",
    "QUEUE_ZSETS": "QUEUE_ZSET_STATES",
    "QUEUE_SETS": "QUEUE_SET_STATES",
}
_MIN_COLONS_FOR_REDIS_KEY = 2


def _py_source() -> str:
    return PY_RESET.read_text()


def _ts_source() -> str:
    return TS_RESET.read_text()


def _ts_topology_source() -> str:
    return TS_SAGA_TOPOLOGY.read_text()


def _py_region(pattern: str) -> str:
    match = re.search(rf"{pattern}.*?{_PY_TOP_LEVEL}", _py_source(), re.M | re.S)
    assert match, f"{pattern} not found in {PY_RESET}"
    return match.group(0)


def _ts_method(name: str) -> str:
    match = re.search(
        rf"^  (?:private )?async {name}\(.*?(?=^  (?:private )?async |^\}})",
        _ts_source(),
        re.M | re.S,
    )
    assert match, f"{name} not found in {TS_RESET}"
    return match.group(0)


def _py_postgres_shared_and_baremetal_regions() -> tuple[str, str]:
    reset = _py_region(r"^def _reset_postgres\(")
    assert _BAREMETAL_BRANCH in reset, f"baremetal branch marker missing from _reset_postgres in {PY_RESET}"
    shared, baremetal = reset.split(_BAREMETAL_BRANCH, 1)
    sibling = _py_region(r"^_OPEN_SIBLING_SERVERS\b")
    discover = _py_region(r"^def _discover_affected_devices\(")
    return sibling + shared + discover, baremetal


def _saga_constants(source: str, pattern: re.Pattern[str]) -> dict[str, list[str]]:
    return {m.group(1): _LITERAL_MEMBER.findall(m.group(2)) for m in pattern.finditer(source)}


def _redis_key_shapes(source: str, literal: re.Pattern[str], placeholder: re.Pattern[str]) -> set[str]:
    shapes = {placeholder.sub("%s", lit) for lit in literal.findall(source)}
    return {s for s in shapes if s.count(":") >= _MIN_COLONS_FOR_REDIS_KEY}


def test_postgres_identifiers_match_between_python_and_typescript():
    shared, _ = _py_postgres_shared_and_baremetal_regions()
    python_ids = quoted_sql_identifiers(shared)
    typescript_ids = quoted_sql_identifiers(_ts_method("resetPostgres") + _ts_method("discoverAffectedDevices"))

    assert python_ids, "no quoted identifiers extracted from the python reset"
    assert typescript_ids, "no quoted identifiers extracted from the typescript reset"
    assert python_ids == typescript_ids, (
        f"reset drift — python-only: {sorted(python_ids - typescript_ids)}, "
        f"typescript-only: {sorted(typescript_ids - python_ids)}"
    )


def test_python_reset_sql_matches_hub_prisma_schema():
    violations = sql_schema_violations(_py_region(r"^_OPEN_SIBLING_SERVERS\b") + _py_region(r"^def _reset_postgres\("))
    violations += sql_schema_violations(_py_region(r"^def _discover_affected_devices\("))
    assert not violations, f"{PY_RESET.name} drifted from the hub prisma schema:\n  " + "\n  ".join(violations)


def test_typescript_reset_sql_matches_hub_prisma_schema():
    violations = sql_schema_violations(_ts_method("resetPostgres"))
    violations += sql_schema_violations(_ts_method("discoverAffectedDevices"))
    assert not violations, f"{TS_RESET.name} drifted from the hub prisma schema:\n  " + "\n  ".join(violations)


def test_baremetal_only_reset_stays_scoped_to_interface_ip_cleanup():
    shared, baremetal = _py_postgres_shared_and_baremetal_regions()
    extra_tables = (quoted_sql_identifiers(baremetal) - quoted_sql_identifiers(shared)) & hub_prisma_schema().tables
    assert extra_tables == {"Interface", "IpAddress"}, (
        f"the python-only baremetal reset branch grew new tables {sorted(extra_tables)} — "
        f"decide whether {TS_RESET.name} needs them before widening this assertion"
    )


def _ts_saga_constants() -> dict[str, list[str]]:
    arrays = {
        m.group(1): _LITERAL_MEMBER.findall(m.group(2)) for m in _TS_TOPOLOGY_ARRAY.finditer(_ts_topology_source())
    }
    return {parity: arrays[ts_name] for parity, ts_name in _TS_TOPOLOGY_CONST_NAMES.items() if ts_name in arrays}


def _ts_queue_key_shapes() -> set[str]:
    strings = dict(_TS_TOPOLOGY_STRING.findall(_ts_topology_source()))
    shapes = set()
    for prefix_const, name, suffix in _TS_QUEUE_KEY_CALL.findall(_ts_method("resetRedis")):
        prefix = strings.get(prefix_const)
        assert prefix, f"{prefix_const} not resolvable from {TS_SAGA_TOPOLOGY.name}"
        shapes.add(_TS_PLACEHOLDER.sub("%s", f"{prefix}:{name}:{suffix}"))
    return shapes


def test_saga_queue_constants_match_between_python_and_typescript():
    python_consts = _saga_constants(_py_source(), _PY_SAGA_CONST)
    typescript_consts = _ts_saga_constants()

    assert set(python_consts) == _SAGA_CONST_NAMES, f"unexpected python saga constants: {sorted(python_consts)}"
    assert set(typescript_consts) == _SAGA_CONST_NAMES, (
        f"unexpected typescript saga constants: {sorted(typescript_consts)}"
    )
    assert python_consts == typescript_consts
    assert "SAGA_QUEUE_NAMES" in _ts_method("resetRedis"), "resetRedis must consume the shared saga topology"


def test_redis_key_shapes_match_between_python_and_typescript():
    python_keys = _redis_key_shapes(_py_region(r"^def _reset_redis\("), _PY_FSTRING, _PY_PLACEHOLDER)
    typescript_keys = (
        _redis_key_shapes(_ts_method("resetRedis"), _TS_TEMPLATE, _TS_PLACEHOLDER) | _ts_queue_key_shapes()
    )

    assert python_keys, "no redis key shapes extracted from the python reset"
    assert python_keys == typescript_keys, (
        f"redis key drift — python-only: {sorted(python_keys - typescript_keys)}, "
        f"typescript-only: {sorted(typescript_keys - python_keys)}"
    )
