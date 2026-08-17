#!/usr/bin/env python
"""Generator: ``~/.ssh/*.pub`` → ``SshKeys`` SQL (prints to stdout).

``userId`` resolves at apply-time via a ``User.email`` subquery; if the owner row doesn't exist yet
the INSERT...SELECT matches nothing (warn-and-skip)."""

from __future__ import annotations

from pathlib import Path

from local.config import get_settings
from local.logger import log
from local.seed.ssh_keys import iter_ssh_pubkeys, ssh_fingerprint
from local.sqlemit import header, logs_to_stderr, q


def generate() -> str:
    emails = get_settings().sim.owner_emails
    keys = iter_ssh_pubkeys(Path.home() / ".ssh")

    out = [header("30-ssh-keys.py")]
    if not emails:
        out.append("-- no owner emails configured; nothing to seed\n")
        return "".join(out)
    if not keys:
        out.append("-- no *.pub files in ~/.ssh; nothing to seed\n")
        return "".join(out)

    out.append("BEGIN;\n\n")
    for email in emails:
        out.append(f"-- SSH keys for {email}\n")
        for name, key_text in keys:
            try:
                fp = ssh_fingerprint(key_text)
            except Exception as exc:  # skip malformed keys rather than failing the seed
                log.warn(f"skip {name}.pub: {exc}")
                out.append(f"-- skipped {name}.pub: malformed\n")
                continue
            out.append(
                f"""INSERT INTO "SshKeys" (id, name, fingerprint, key, "userId", "dateCreated")
SELECT gen_random_uuid(), {q(name)}, {q(fp)}, {q(key_text)}, u.id, NOW()
FROM "User" u
WHERE u.email = {q(email)}
  AND NOT EXISTS (
    SELECT 1 FROM "SshKeys" k
    WHERE k."userId" = u.id AND k.fingerprint = {q(fp)} AND k."dateDeleted" IS NULL
  );
"""
            )
        out.append("\n")
    out.append("COMMIT;\n")
    return "".join(out)


if __name__ == "__main__":
    logs_to_stderr()
    print(generate(), end="")
