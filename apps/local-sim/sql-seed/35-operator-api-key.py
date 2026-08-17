#!/usr/bin/env python
"""Generator: deterministic operator API key (admin-api → hub) as a better-auth ``apikey`` row.

Stores ``base64url(sha256(plaintext))`` (no padding) in ``key``; plaintext must match the
``HUB_OPERATOR_API_KEY`` default in ``secretspec.toml`` [profiles.local] — keep them in lockstep."""

from __future__ import annotations

import base64
import hashlib
import os

from local.config import get_settings
from local.sqlemit import header, logs_to_stderr, q

# Mirrors secretspec.toml [profiles.local] HUB_OPERATOR_API_KEY.
DEFAULT_LOCAL_KEY = "brk_local_operator_0000000000000000000000000000"


def hashed_key(plaintext: str) -> str:
    digest = hashlib.sha256(plaintext.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def generate() -> str:
    settings = get_settings()
    org_id = settings.sim.hydrahost_org_id
    emails = settings.sim.owner_emails

    plaintext = os.environ.get("HUB_OPERATOR_API_KEY") or DEFAULT_LOCAL_KEY
    key_hash = hashed_key(plaintext)

    out = [header("35-operator-api-key.py")]
    if not emails:
        out.append("-- no owner emails configured; nothing to seed\n")
        return "".join(out)

    owner_email = emails[0]
    out.append(
        f"""BEGIN;

-- Operator API key for admin-api → hub service-to-service lifecycle calls.
-- Owned by the sim Owner, scoped to the admin org; rate limiting disabled
-- (service traffic). Guarded by NOT EXISTS on the hashed key (no unique
-- constraint on "key"), so re-applying is a no-op.
INSERT INTO "apikey" (id, name, start, prefix, key, "userId", "organizationId",
                      enabled, "rateLimitEnabled", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'local operator lifecycle (admin-api)', {q(plaintext[:6])}, 'brk_',
       {q(key_hash)}, u.id, {q(org_id)}, true, false, NOW(), NOW()
FROM "User" u
WHERE u.email = {q(owner_email)}
  AND NOT EXISTS (SELECT 1 FROM "apikey" k WHERE k.key = {q(key_hash)});

COMMIT;
"""
    )
    return "".join(out)


if __name__ == "__main__":
    logs_to_stderr()
    print(generate(), end="")
