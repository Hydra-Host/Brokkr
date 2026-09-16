from __future__ import annotations

from local.sqlemit import emit_upsert, q, qe


def emit_tag(tag_id: str, name: str, slug: str, color: str, org_id: str) -> str:
    return emit_upsert(
        "Tag",
        "id name slug color organizationId",
        [q(tag_id), q(name), q(slug), q(color), q(org_id)],
        "organizationId name",
    )


def emit_tag_assign(tag_id: str, obj_type: str, object_sql: str) -> str:
    return emit_upsert(
        "TagAssignment",
        "tagId objectType objectId",
        [q(tag_id), qe(obj_type, "TagObjectType"), object_sql],
        "tagId objectType objectId",
        do_nothing=True,
        updated_at=False,
    )
