from __future__ import annotations

import importlib.util
from pathlib import Path

import local.config as cfg
import pytest
from local.prisma_schema import (
    hub_prisma_schema,
    parse_prisma_schema,
    sql_schema_violations,
    strip_sql_literals,
)

_SIM_ROOT = Path(__file__).resolve().parents[1]
_SQL_SEED = _SIM_ROOT / "sql-seed"
_FIXTURE_FLEET = Path(__file__).resolve().parent / "fixtures" / "fleet.yml"

_GENERATORS = sorted(p.name for p in _SQL_SEED.glob("*.py"))
_STATIC_SQL = sorted(p.name for p in _SQL_SEED.glob("*.sql"))
_OS_CATALOG = "40-os-catalog.py"

_OS_MANIFEST = {
    "version": "drift-gate",
    "groups": [{"slug": "os", "name": "OS", "selection_type": "SINGLE_SELECT"}],
    "layers": [
        {
            "name": "ubuntu-2404",
            "group": "os",
            "kind": "base",
            "display_name": "Ubuntu 24.04",
            "version": "24.04",
            "family": "ubuntu",
            "os_distro": "ubuntu",
            "os_codename": "noble",
            "os_version": "24.04",
            "arch": "amd64",
            "sha256": "a" * 64,
            "url": "https://example.test/img",
            "size": 123,
            "built_at": "2026-01-01T00:00:00Z",
            "built_by_pipeline_id": 1,
        }
    ],
}


def _load(filename: str):
    mod_name = filename.replace("-", "_").removesuffix(".py")
    spec = importlib.util.spec_from_file_location(mod_name, _SQL_SEED / filename)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(autouse=True)
def fixture_fleet(monkeypatch):
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(_FIXTURE_FLEET))
    cfg.get_settings.cache_clear()


@pytest.fixture
def generated_sql(monkeypatch):
    def generate(filename: str) -> str:
        if filename == _OS_CATALOG:
            import local.seed.os_catalog as os_catalog

            monkeypatch.setattr(os_catalog, "fetch_manifest", lambda: _OS_MANIFEST)
        return strip_sql_literals(_load(filename).generate())

    return generate


def test_generator_and_static_sql_discovery_is_not_empty():
    assert _GENERATORS, f"no generators found under {_SQL_SEED}"
    assert _STATIC_SQL, f"no static SQL found under {_SQL_SEED}"


def test_prisma_parser_resolves_model_to_mapped_table_name():
    schema = hub_prisma_schema()
    api_key = next(m for m in schema.models if m.name == "ApiKey")
    assert api_key.table == "apikey"
    assert "apikey" in schema.tables
    assert "ApiKey" not in schema.tables


def test_prisma_parser_finds_unmapped_models_columns_and_enums():
    schema = hub_prisma_schema()
    assert {"Device", "Server", "Zone", "User", "Member"} <= schema.tables
    assert {"DeviceRole", "DeviceStatus", "ServerLifecycleStatus"} <= schema.enums

    device = schema.model_for_table("Device")
    assert {"id", "name", "status", "role", "zoneId", "networkType"} <= device.columns
    assert {"lifecycleStatus", "storageLayouts"} <= schema.model_for_table("Server").columns


def test_prisma_parser_excludes_relation_fields_from_columns():
    server = hub_prisma_schema().model_for_table("Server")
    assert "device" in server.fields
    assert "device" not in server.columns


def test_prisma_parser_collects_enum_members():
    schema = hub_prisma_schema()
    lifecycle = schema.enum_for_cast("ServerLifecycleStatus")
    assert lifecycle is not None
    assert {"INVENTORY", "PROVISIONING", "PROVISIONED", "OFFLINE", "FAILED", "DEPROVISIONING"} == lifecycle.members
    assert {"PLANNED", "STAGED", "ACTIVE", "MAINTENANCE"} == schema.enum_for_cast("DeviceStatus").members


def test_prisma_parser_resolves_enum_typed_columns_to_their_enum():
    schema = hub_prisma_schema()
    assert schema.model_for_table("Device").type_of("status") == "DeviceStatus"
    assert schema.model_for_table("Server").type_of("lifecycleStatus") == "ServerLifecycleStatus"
    assert schema.enum_for_field_type("ServerLifecycleStatus").type_name == "ServerLifecycleStatus"


def test_prisma_parser_reads_enum_type_map_only_from_double_at_lines(tmp_path):
    (tmp_path / "models").mkdir()
    (tmp_path / "models" / "x.prisma").write_text(
        'enum Colour {\n  RED @map("crimson")\n  BLUE\n}\n\nmodel Widget {\n  id String @id\n  hue Colour\n}\n'
    )
    schema = parse_prisma_schema(tmp_path)
    colour = schema.enum_for_cast("Colour")
    assert colour is not None
    assert colour.members == {"crimson", "BLUE"}
    assert "crimson" not in schema.enums


def test_prisma_parser_resolves_double_at_map_on_an_enum_type(tmp_path):
    (tmp_path / "models").mkdir()
    (tmp_path / "models" / "x.prisma").write_text('enum Colour {\n  RED\n  BLUE\n\n  @@map("colour_t")\n}\n')
    schema = parse_prisma_schema(tmp_path)
    assert schema.enum_for_cast("colour_t") is not None
    assert schema.enum_for_field_type("Colour").type_name == "colour_t"
    assert schema.enum_for_cast("colour_t").members == {"RED", "BLUE"}


def test_bare_column_in_an_update_set_clause_is_checked_against_the_updated_table():
    assert not sql_schema_violations("""UPDATE "Device" SET status = 'ACTIVE' WHERE id = ANY(%s)""")
    violations = sql_schema_violations("""UPDATE "Device" SET statusRenamed = 'ACTIVE' WHERE id = ANY(%s)""")
    assert violations == ['UPDATE "Device" SET: "statusRenamed" is not a column of "Device" (model Device)']


def test_bare_column_in_an_update_set_clause_is_not_masked_by_another_model():
    violations = sql_schema_violations("""UPDATE "Device" SET lifecycleStatus = 'INVENTORY'""")
    assert violations == ['UPDATE "Device" SET: "lifecycleStatus" is not a column of "Device" (model Device)']


def test_quoted_camel_case_column_in_an_update_set_clause_is_still_checked():
    assert not sql_schema_violations('UPDATE "Device" SET "zoneId" = %s')
    violations = sql_schema_violations('UPDATE "Device" SET "zoneIdRenamed" = %s')
    assert 'UPDATE "Device" SET: "zoneIdRenamed" is not a column of "Device" (model Device)' in violations


def test_sql_functions_and_keywords_in_a_set_clause_are_not_read_as_columns():
    sql = "UPDATE \"Device\" SET status = 'ACTIVE', \"updatedAt\" = NOW() WHERE id = ANY(%s) AND status != 'ACTIVE'"
    assert not sql_schema_violations(sql)


def test_python_string_concatenation_debris_in_a_set_clause_is_not_read_as_a_column():
    sql = 'f\'UPDATE "Deployment" SET "endDate" = NOW(), "updatedAt" = NOW() \' f\'WHERE "endDate" IS NULL\''
    assert not sql_schema_violations(sql)


def test_bare_alias_qualified_column_is_attributed_to_the_aliased_table():
    assert not sql_schema_violations("""SELECT k.id FROM "apikey" k WHERE k.key = %s""")
    violations = sql_schema_violations("""SELECT k.id FROM "apikey" k WHERE k.keyRenamed = %s""")
    assert violations == ['k.*: "keyRenamed" is not a column of "apikey" (model ApiKey)']


def test_bare_alias_qualified_column_is_checked_in_a_select_list():
    assert not sql_schema_violations('SELECT d.id, d.name, d."zoneId" FROM "Device" d')
    violations = sql_schema_violations('SELECT d.id, d.nameRenamed, d."zoneId" FROM "Device" d')
    assert violations == ['d.*: "nameRenamed" is not a column of "Device" (model Device)']


def test_one_alias_bound_to_two_tables_resolves_per_statement():
    assert not sql_schema_violations('SELECT d."deletedAt" FROM "Device" d; SELECT d.id FROM "Deployment" d;')
    assert not sql_schema_violations('SELECT d.id FROM "Deployment" d; SELECT d."deletedAt" FROM "Device" d;')


def test_a_reused_alias_hides_a_rename_in_neither_statement_order():
    expected = ['d.*: "nameRenamed" is not a column of "Device" (model Device)']
    assert sql_schema_violations('SELECT d.nameRenamed FROM "Device" d; SELECT d.id FROM "Deployment" d;') == expected
    assert sql_schema_violations('SELECT d.id FROM "Deployment" d; SELECT d.nameRenamed FROM "Device" d;') == expected


def test_identifiers_inside_a_dollar_quoted_body_are_checked_without_splitting_on_its_semicolons():
    body = "CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN PERFORM 1; PERFORM 2; END $$ LANGUAGE plpgsql;"
    assert not sql_schema_violations(body)
    renamed = body.replace("PERFORM 2", 'PERFORM 1 FROM "Device" d WHERE d.nameRenamed IS NULL')
    assert sql_schema_violations(renamed) == ['d.*: "nameRenamed" is not a column of "Device" (model Device)']


def test_host_language_property_access_is_not_read_as_an_alias_qualified_column():
    sql = (
        '`SELECT d.id FROM "Device" d JOIN "Reservation" r ON r.id = d.id`,\n'
        "result.rows.map((r) => ({ name: String(r.name), zoneId: String(r.zoneId) }))"
    )
    assert not sql_schema_violations(sql)


def test_uncast_enum_literal_assigned_in_an_update_set_is_checked_against_members():
    assert not sql_schema_violations("""UPDATE "Server" SET "lifecycleStatus" = 'INVENTORY'""")
    violations = sql_schema_violations("""UPDATE "Server" SET "lifecycleStatus" = 'STOCK'""")
    assert violations == [
        'UPDATE "Server" SET: "STOCK" is not a member of enum "ServerLifecycleStatus" (column "lifecycleStatus")'
    ]


def test_uncast_enum_literal_assigned_to_a_bare_column_is_checked_against_members():
    violations = sql_schema_violations("""UPDATE "Device" SET status = 'LIVE' WHERE id = ANY(%s)""")
    assert violations == ['UPDATE "Device" SET: "LIVE" is not a member of enum "DeviceStatus" (column "status")']


def test_cast_enum_literal_is_checked_against_members():
    assert not sql_schema_violations("""INSERT INTO "Device" (status) VALUES ('ACTIVE'::"DeviceStatus")""")
    violations = sql_schema_violations("""INSERT INTO "Device" (status) VALUES ('LIVE'::"DeviceStatus")""")
    assert violations == ['"LIVE" is not a member of enum "DeviceStatus"']


def test_cast_enum_literal_survives_literal_stripping():
    stripped = strip_sql_literals("""INSERT INTO "Device" (status) VALUES ('LIVE'::"DeviceStatus")""")
    assert "'LIVE'" in stripped
    assert sql_schema_violations(stripped) == ['"LIVE" is not a member of enum "DeviceStatus"']


def test_non_enum_cast_literals_are_still_stripped():
    stripped = strip_sql_literals("""INSERT INTO "Server" ("storageLayouts") VALUES ('{"configs": []}'::jsonb)""")
    assert "configs" not in stripped
    assert not sql_schema_violations(stripped)


@pytest.mark.parametrize("generator", _GENERATORS)
def test_generated_sql_matches_hub_prisma_schema(generator, generated_sql):
    violations = sql_schema_violations(generated_sql(generator))
    assert not violations, f"{generator} drifted from the hub prisma schema:\n  " + "\n  ".join(violations)


@pytest.mark.parametrize("static_sql", _STATIC_SQL)
def test_static_sql_matches_hub_prisma_schema(static_sql):
    sql = strip_sql_literals((_SQL_SEED / static_sql).read_text())
    violations = sql_schema_violations(sql)
    assert not violations, f"{static_sql} drifted from the hub prisma schema:\n  " + "\n  ".join(violations)
