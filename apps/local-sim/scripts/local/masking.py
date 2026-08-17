from __future__ import annotations

from urllib.parse import urlsplit, urlunsplit


def mask_dsn(value: str) -> str:
    """Redact the whole userinfo, not just the password — a secret can ride in the username
    (token-as-username with no password), which password-only masking would leak."""
    parts = urlsplit(value)
    if not (parts.username or parts.password):
        return value
    host = parts.hostname or ""
    port = f":{parts.port}" if parts.port else ""
    return urlunsplit((parts.scheme, f"***@{host}{port}", parts.path, parts.query, parts.fragment))
