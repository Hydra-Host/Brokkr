from __future__ import annotations

from local.masking import mask_dsn


def test_mask_dsn_redacts_password_and_user() -> None:
    assert mask_dsn("postgresql://brokkr:password@127.0.0.1:5432/brokkr") == "postgresql://***@127.0.0.1:5432/brokkr"


def test_mask_dsn_masks_username_only_userinfo() -> None:
    assert mask_dsn("https://s.token-abc123@vault.local/path") == "https://***@vault.local/path"


def test_mask_dsn_masks_password_only_userinfo() -> None:
    assert mask_dsn("redis://:s3cr3t@127.0.0.1:6379") == "redis://***@127.0.0.1:6379"


def test_mask_dsn_leaves_userinfo_free_url_unchanged() -> None:
    assert mask_dsn("redis://127.0.0.1:6379") == "redis://127.0.0.1:6379"
