"""Offline reader for the hub's Prisma schema, plus the drift check sim SQL is held to.

Parses the multi-file schema (``packages/database/prisma/``) as text: no Prisma CLI,
no database, no network. Exists so sim tests can assert the raw SQL identifiers the seed
generators and the device-reset path emit still exist in the hub schema.

Both quoted and bare identifiers are checked — the all-lowercase single-word columns
(``status``, ``name``, ``id``, ``key``) are exactly the ones legal to write unquoted, so
skipping them would leave half the emitted SQL ungated. Enum *members* are checked too,
since renaming one is the routine case and breaks the same SQL a type rename would.

``@@map`` / ``@map`` are resolved, so neither a model nor an enum name is assumed to be its
DB name (e.g. ``model ApiKey`` is table ``apikey``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[4]
_HUB_PRISMA_DIR = _REPO_ROOT / "packages" / "database" / "prisma"

_BLOCK_RE = re.compile(r"^(model|enum|view)\s+(\w+)\s*\{(.*?)^\}", re.M | re.S)
_MAP_RE = re.compile(r'@@?map\("([^"]+)"\)')
_FIELD_RE = re.compile(r"^\s*(\w+)\s+(\S+)")
_ENUM_MEMBER_RE = re.compile(r"^([A-Za-z_]\w*)")


@dataclass(frozen=True)
class PrismaModel:
    """One ``model``/``view`` block, with Prisma names and DB names kept distinct."""

    name: str
    table: str
    columns: frozenset[str]
    fields: frozenset[str]
    column_types: frozenset[tuple[str, str]]

    def type_of(self, column: str) -> str | None:
        """The declared Prisma type of ``column`` (DB column name), stripped of ``?``/``[]``."""
        return next((t for c, t in self.column_types if c == column), None)


@dataclass(frozen=True)
class PrismaEnum:
    """One ``enum`` block. ``name`` is the Prisma type a field declares; ``type_name`` is the
    DB type name a ``::"X"`` cast writes (they differ only under ``@@map``)."""

    name: str
    type_name: str
    members: frozenset[str]


@dataclass(frozen=True)
class PrismaSchema:
    models: tuple[PrismaModel, ...]
    enum_types: tuple[PrismaEnum, ...]

    @property
    def enums(self) -> frozenset[str]:
        return frozenset(e.type_name for e in self.enum_types)

    @property
    def tables(self) -> frozenset[str]:
        return frozenset(m.table for m in self.models)

    @property
    def columns(self) -> frozenset[str]:
        return frozenset().union(*(m.columns for m in self.models)) if self.models else frozenset()

    @property
    def identifiers(self) -> frozenset[str]:
        """Every quoted identifier a hand-written SQL statement may legitimately name."""
        return self.tables | self.columns | self.enums

    def model_for_table(self, table: str) -> PrismaModel | None:
        return next((m for m in self.models if m.table == table), None)

    def enum_for_cast(self, type_name: str) -> PrismaEnum | None:
        """Resolve the enum a ``::"type_name"`` cast targets."""
        return next((e for e in self.enum_types if e.type_name == type_name), None)

    def enum_for_field_type(self, name: str | None) -> PrismaEnum | None:
        """Resolve the enum a model field is declared as, so an uncast literal is checkable."""
        return next((e for e in self.enum_types if e.name == name), None) if name else None


def _strip_comments(text: str) -> str:
    return re.sub(r"//[^\n]*", "", text)


def _parse_blocks(text: str) -> tuple[list[tuple[str, str, str]], set[str]]:
    """Return ``(model_blocks, model_names)`` — names are needed to spot relation fields."""
    blocks = [(kind, name, body) for kind, name, body in _BLOCK_RE.findall(text)]
    names = {name for kind, name, _ in blocks if kind in ("model", "view")}
    return blocks, names


def _parse_model(name: str, body: str, model_names: set[str]) -> PrismaModel:
    table = name
    fields: set[str] = set()
    columns: set[str] = set()
    column_types: set[tuple[str, str]] = set()

    for line in body.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("@@"):
            if match := _MAP_RE.search(stripped):
                table = match.group(1)
            continue
        field = _FIELD_RE.match(line)
        if not field:
            continue
        field_name, field_type = field.group(1), field.group(2)
        fields.add(field_name)
        # a field typed as another model is a relation — it backs no column of its own
        if field_type.rstrip("?[]") in model_names:
            continue
        mapped = _MAP_RE.search(stripped)
        column = mapped.group(1) if mapped else field_name
        columns.add(column)
        column_types.add((column, field_type.rstrip("?[]")))

    return PrismaModel(
        name=name,
        table=table,
        columns=frozenset(columns),
        fields=frozenset(fields),
        column_types=frozenset(column_types),
    )


def _parse_enum(name: str, body: str) -> PrismaEnum:
    type_name = name
    members: set[str] = set()

    for line in body.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        # `@@`-prefixed only, matching _parse_model: a value-level `@map` renames that member,
        # never the enum type.
        if stripped.startswith("@@"):
            if match := _MAP_RE.search(stripped):
                type_name = match.group(1)
            continue
        member = _ENUM_MEMBER_RE.match(stripped)
        if not member:
            continue
        mapped = _MAP_RE.search(stripped)
        members.add(mapped.group(1) if mapped else member.group(1))

    return PrismaEnum(name=name, type_name=type_name, members=frozenset(members))


def parse_prisma_schema(prisma_dir: Path) -> PrismaSchema:
    """Parse ``schema.prisma`` plus every ``models/*.prisma`` under ``prisma_dir``."""
    sources = sorted(prisma_dir.glob("models/*.prisma"))
    root = prisma_dir / "schema.prisma"
    if root.is_file():
        sources.append(root)
    if not sources:
        raise FileNotFoundError(f"no prisma schema files under {prisma_dir}")

    text = _strip_comments("\n".join(p.read_text() for p in sources))
    blocks, model_names = _parse_blocks(text)

    models: list[PrismaModel] = []
    enum_types: list[PrismaEnum] = []
    for kind, name, body in blocks:
        if kind == "enum":
            enum_types.append(_parse_enum(name, body))
        else:
            models.append(_parse_model(name, body, model_names))

    return PrismaSchema(models=tuple(models), enum_types=tuple(enum_types))


@lru_cache(maxsize=1)
def hub_prisma_schema() -> PrismaSchema:
    return parse_prisma_schema(_HUB_PRISMA_DIR)


_ENUM_CAST_AHEAD = re.compile(r'\s*::\s*"[A-Za-z_]\w*"')


def strip_sql_literals(sql: str) -> str:
    """Blank out string literals and comments so only identifiers remain.

    Enum-cast literals (``'X'::"Enum"``) are kept verbatim: the value is itself checkable
    against the enum's members, and blanking it is what used to hide a member rename.
    """
    out: list[str] = []
    i, n = 0, len(sql)
    while i < n:
        if sql[i] == "'":
            start = i
            i += 1
            while i < n:
                if sql[i] == "'":
                    if sql.startswith("''", i):
                        i += 2
                        continue
                    i += 1
                    break
                i += 1
            out.append(sql[start:i] if _ENUM_CAST_AHEAD.match(sql, i) else " ")
        elif sql.startswith("--", i):
            end = sql.find("\n", i)
            i = n if end < 0 else end
            out.append(" ")
        elif sql.startswith("/*", i):
            end = sql.find("*/", i + 2)
            i = n if end < 0 else end + 2
            out.append(" ")
        elif sql[i] == '"':
            end = sql.find('"', i + 1)
            if end < 0:
                out.append(sql[i:])
                i = n
            else:
                out.append(sql[i : end + 1])
                i = end + 1
        else:
            out.append(sql[i])
            i += 1
    return "".join(out)


_DOLLAR_TAG = re.compile(r"\$(\w*)\$")


def _split_statements(sql: str) -> list[str]:
    """Split a statement stream on top-level ``;``.

    An alias binds per statement, so one reused for a different table later must not shadow the
    earlier binding. Dollar-quoted bodies carry their own semicolons, so they are skipped whole
    alongside literals, comments and quoted identifiers.
    """
    parts: list[str] = []
    start, i, n = 0, 0, len(sql)
    while i < n:
        if sql[i] == "'":
            i += 1
            while i < n:
                if sql[i] == "'":
                    if sql.startswith("''", i):
                        i += 2
                        continue
                    i += 1
                    break
                i += 1
        elif sql[i] == '"':
            end = sql.find('"', i + 1)
            i = n if end < 0 else end + 1
        elif sql.startswith("--", i):
            end = sql.find("\n", i)
            i = n if end < 0 else end
        elif sql.startswith("/*", i):
            end = sql.find("*/", i + 2)
            i = n if end < 0 else end + 2
        elif sql[i] == "$" and (tag := _DOLLAR_TAG.match(sql, i)):
            close = sql.find(tag.group(0), tag.end())
            i = n if close < 0 else close + len(tag.group(0))
        elif sql[i] == ";":
            parts.append(sql[start:i])
            start = i = i + 1
        else:
            i += 1
    parts.append(sql[start:])
    return [p for p in parts if p.strip()]


_TABLE_REF = re.compile(r'(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|FROM|JOIN)\s+"([A-Za-z_]\w*)"', re.I)
_ALIAS_BIND = re.compile(r'(?:FROM|JOIN|UPDATE)\s+"([A-Za-z_]\w*)"\s+(?:AS\s+)?(\w+)', re.I)
_ALIAS_COL = re.compile(r"\b([a-z_]\w*)\.\"([A-Za-z_]\w*)\"")
# An unquoted alias-qualified column is ambiguous with host-language attribute access once SQL is
# read out of source (`String(r.name)` vs `SELECT d.name`), so require a leading SQL clause token —
# the disambiguator the double quotes provide for _ALIAS_COL.
_BARE_ALIAS_COL = re.compile(r"(?:,|=|\b(?i:SELECT|WHERE|AND|OR|ON|NOT|IN)\b)\s*([a-z_]\w*)\.([a-z_]\w*)")
_INSERT_COLS = re.compile(r'INSERT\s+INTO\s+"([A-Za-z_]\w*)"\s*\(([^)]*)\)', re.I)
_UPDATE_SET = re.compile(
    r'UPDATE\s+"([A-Za-z_]\w*)"(?:\s+(?:AS\s+)?\w+)?\s+SET\s+(.*?)(?=\bWHERE\b|\bFROM\b|$)',
    re.I | re.S,
)
# One `col = value` of a SET clause, capturing the assignment target quoted or bare plus the RHS
# literal when there is one. Parsing per assignment (rather than every bare word in the clause)
# is what keeps SQL functions, keywords and host-language quoting debris out of the column set —
# and consuming the RHS literal is what stops a comma inside it from splitting the next target.
_SET_ASSIGNMENT = re.compile(r"""(?:^|,)\s*(?:"([A-Za-z_]\w*)"|([a-z_]\w*))\s*=\s*(?:'((?:[^']|'')*)')?""")
_ENUM_CAST = re.compile(r'::"([A-Za-z_]\w*)"')
_ENUM_LITERAL_CAST = re.compile(r"""'((?:[^']|'')*)'\s*::\s*"([A-Za-z_]\w*)\"""")
_QUOTED = re.compile(r'"([A-Za-z_]\w*)"')
_BARE_IDENT = re.compile(r"[A-Za-z_]\w*")
# a quoted name used as a dict/map subscript in embedded-SQL source is not a SQL identifier
_SUBSCRIPT_KEY = re.compile(r'\[\s*"[A-Za-z_]\w*"\s*\]')

# words that can follow a table reference where an alias would otherwise be read
_NOT_AN_ALIAS = frozenset(
    {
        "where",
        "set",
        "on",
        "values",
        "select",
        "group",
        "order",
        "limit",
        "offset",
        "returning",
        "do",
        "join",
        "left",
        "right",
        "inner",
        "outer",
        "cross",
        "full",
        "using",
        "and",
        "or",
        "as",
        "from",
        "conflict",
        "union",
        "having",
        "for",
        "into",
    }
)


def quoted_sql_identifiers(source: str) -> set[str]:
    """Every double-quoted SQL identifier in ``source`` (raw SQL or SQL embedded in code)."""
    return set(_QUOTED.findall(_normalize(source)))


def _normalize(sql: str) -> str:
    unescaped = sql.replace('\\"', '"').replace("\\'", "'")
    return _SUBSCRIPT_KEY.sub("[]", unescaped)


def _alias_map(sql: str, schema: PrismaSchema) -> dict[str, PrismaModel]:
    aliases: dict[str, PrismaModel] = {}
    for table, alias in _ALIAS_BIND.findall(sql):
        if alias.lower() in _NOT_AN_ALIAS:
            continue
        if model := schema.model_for_table(table):
            aliases[alias] = model
    return aliases


def _check_columns(model: PrismaModel, names: set[str], context: str, out: list[str]) -> None:
    for name in sorted(names - model.columns):
        out.append(f'{context}: "{name}" is not a column of "{model.table}" (model {model.name})')


def sql_schema_violations(sql: str, schema: PrismaSchema | None = None) -> list[str]:
    """Report every identifier and enum literal in ``sql`` the hub schema cannot account for.

    Column checks are per-table wherever the SQL makes the owning table unambiguous
    (INSERT column lists, ``UPDATE ... SET`` clauses, alias-qualified references); a
    same-named column on some other model therefore can't mask a rename. Anything
    left over falls back to the schema-wide identifier set.

    Enum literals are validated against the enum's members both when the SQL casts them
    (``'X'::"Enum"``) and when an ``UPDATE ... SET`` assigns one to a column whose declared
    type resolves to an enum — the uncast form the device reset writes.

    ``sql`` may be a full statement stream or SQL embedded in source. Only alias resolution is
    split per statement — an alias reused for a different table would otherwise resolve to
    whichever binding came last, misattributing every earlier reference. Dollar-quoted bodies
    are skipped whole by the splitter, so plpgsql and concatenated fragments stay safe.
    """
    schema = schema or hub_prisma_schema()
    normalized = _normalize(sql)
    violations: list[str] = []

    for table in sorted(set(_TABLE_REF.findall(normalized))):
        if table not in schema.tables:
            violations.append(f'unknown table "{table}"')

    for enum in sorted(set(_ENUM_CAST.findall(normalized))):
        if enum not in schema.enums:
            violations.append(f'unknown enum type "{enum}"')

    for literal, type_name in _ENUM_LITERAL_CAST.findall(normalized):
        enum = schema.enum_for_cast(type_name)
        if enum and literal not in enum.members:
            violations.append(f'"{literal}" is not a member of enum "{type_name}"')

    by_alias: dict[tuple[str, str], tuple[PrismaModel, set[str]]] = {}
    for statement in _split_statements(normalized):
        aliases = _alias_map(statement, schema)
        for pattern in (_ALIAS_COL, _BARE_ALIAS_COL):
            for alias, column in pattern.findall(statement):
                if model := aliases.get(alias):
                    by_alias.setdefault((alias, model.table), (model, set()))[1].add(column)
    for (alias, _), (model, columns) in sorted(by_alias.items()):
        _check_columns(model, columns, f"{alias}.*", violations)

    # a cast literal reads as a value in a column position and its enum name as a quoted
    # identifier; both are already checked above, so drop the whole construct here
    column_scope = _ENUM_CAST.sub("::", _ENUM_LITERAL_CAST.sub("::", normalized))

    for table, column_list in _INSERT_COLS.findall(column_scope):
        if model := schema.model_for_table(table):
            names = set(_BARE_IDENT.findall(column_list))
            _check_columns(model, names, f'INSERT INTO "{table}"', violations)

    for table, set_clause in _UPDATE_SET.findall(column_scope):
        model = schema.model_for_table(table)
        if model is None:
            continue
        assignments = [(quoted or bare, literal) for quoted, bare, literal in _SET_ASSIGNMENT.findall(set_clause)]
        _check_columns(model, {column for column, _ in assignments}, f'UPDATE "{table}" SET', violations)
        for column, literal in assignments:
            enum = schema.enum_for_field_type(model.type_of(column))
            if literal and enum and literal not in enum.members:
                violations.append(
                    f'UPDATE "{table}" SET: "{literal}" is not a member of enum "{enum.type_name}" (column "{column}")'
                )

    for name in sorted(set(_QUOTED.findall(normalized)) - schema.identifiers):
        violations.append(f'unknown identifier "{name}"')

    return violations
