from __future__ import annotations

import pytest
from local import lock_loss as ll


def test_device_lock_key_matches_bridge_namespace():
    assert ll.device_lock_key("zone-1", "device-1") == "zone-1:lock:device:device-1"


@pytest.mark.parametrize(
    "redis_url",
    [
        "redis://127.0.0.1:6379",
        "redis://localhost:6379/1",
        "redis://[::1]:6379",
    ],
)
def test_simulation_guard_accepts_loopback_redis(redis_url):
    ll.assert_simulation_safe(redis_url, {"LOCAL_SIMULATION_ENABLED": "true"})


def test_simulation_guard_refuses_without_sim_flag():
    with pytest.raises(ll.LockLossRefused, match="LOCAL_SIMULATION_ENABLED"):
        ll.assert_simulation_safe("redis://127.0.0.1:6379", {})


def test_simulation_guard_refuses_non_loopback_redis():
    with pytest.raises(ll.LockLossRefused, match="not loopback"):
        ll.assert_simulation_safe(
            "redis://redis.prod.internal:6379",
            {"LOCAL_SIMULATION_ENABLED": "true"},
        )


class _FakeRedis:
    def __init__(self, *, delete_result=1, set_result=True):
        self.delete_result = delete_result
        self.set_result = set_result
        self.deleted: list[str] = []
        self.set_calls: list[tuple[str, str, int, bool]] = []
        self.closed = False

    def delete(self, key):
        self.deleted.append(key)
        return self.delete_result

    def set(self, key, value, *, ex, xx):
        self.set_calls.append((key, value, ex, xx))
        return self.set_result

    def close(self):
        self.closed = True


def test_delete_removes_exact_namespaced_lock(monkeypatch):
    client = _FakeRedis()
    monkeypatch.setenv("LOCAL_SIMULATION_ENABLED", "true")
    monkeypatch.setattr(ll.redis.Redis, "from_url", lambda *args, **kwargs: client)

    key = ll.inject_lock_loss("redis://127.0.0.1:6379", "zone-1", "device-1", "delete")

    assert key == "zone-1:lock:device:device-1"
    assert client.deleted == [key]
    assert client.closed


def test_replace_uses_foreign_token_with_expiry_and_xx(monkeypatch):
    client = _FakeRedis()
    monkeypatch.setenv("LOCAL_SIMULATION_ENABLED", "true")
    monkeypatch.setattr(ll.redis.Redis, "from_url", lambda *args, **kwargs: client)

    key = ll.inject_lock_loss(
        "redis://localhost:6379",
        "zone-1",
        "device-1",
        "replace",
        replacement_ttl_seconds=75,
    )

    assert client.set_calls == [(key, "local-sim-lock-loss", 75, True)]
    assert client.closed


def test_injection_fails_when_lock_is_not_held(monkeypatch):
    client = _FakeRedis(delete_result=0)
    monkeypatch.setenv("LOCAL_SIMULATION_ENABLED", "true")
    monkeypatch.setattr(ll.redis.Redis, "from_url", lambda *args, **kwargs: client)

    with pytest.raises(ll.DeviceLockMissing, match="not currently held"):
        ll.inject_lock_loss("redis://127.0.0.1:6379", "zone-1", "device-1", "delete")
