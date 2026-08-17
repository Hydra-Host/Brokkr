"""Pure ``~/.ssh/*.pub`` shapers for the ``30-ssh-keys`` SQL generator.

The provision validator requires the reserving user to have ≥1 SshKey row.
"""

from __future__ import annotations

import base64
import hashlib
from pathlib import Path


def ssh_fingerprint(pubkey_line: str) -> str:
    """Compute ``SHA256:<base64>`` matching ``ssh-keygen -lf <file>``, from one ``*.pub`` line."""
    parts = pubkey_line.strip().split()
    if len(parts) < 2:
        raise ValueError(f"malformed pubkey line: {pubkey_line!r}")
    digest = hashlib.sha256(base64.b64decode(parts[1])).digest()
    return "SHA256:" + base64.b64encode(digest).rstrip(b"=").decode("ascii")


def iter_ssh_pubkeys(ssh_dir: Path) -> list[tuple[str, str]]:
    """Return ``(name, key_text)`` for every non-empty ``*.pub`` in ``ssh_dir`` (``name`` = stem)."""
    if not ssh_dir.is_dir():
        return []
    out: list[tuple[str, str]] = []
    for pub in sorted(ssh_dir.glob("*.pub")):
        text = pub.read_text().strip()
        if not text:
            continue
        if text.split(None, 1)[0].endswith("-cert-v01@openssh.com"):
            continue
        out.append((pub.stem, text))
    return out
