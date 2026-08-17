#!/usr/bin/env python
"""Inject device-lock loss into a running local-sim bridge saga."""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Mapping
from typing import Literal
from urllib.parse import urlparse

import redis

from local.config import get_settings
from local.logger import log

_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
_REPLACEMENT_TOKEN = "local-sim-lock-loss"


class LockLossRefused(RuntimeError):
    pass


class DeviceLockMissing(RuntimeError):
    pass


def device_lock_key(zone_id: str, device_id: str) -> str:
    """Build the fully namespaced key used by the bridge's Redis lock client."""
    zone = zone_id.strip()
    device = device_id.strip()
    if not zone or ":" in zone:
        raise ValueError("zone id must be a non-empty Redis-key segment")
    if not device or ":" in device:
        raise ValueError("device id must be a non-empty Redis-key segment")
    return f"{zone}:lock:device:{device}"


def assert_simulation_safe(redis_url: str, environ: Mapping[str, str] | None = None) -> None:
    """Refuse mutation unless both the sim gate and loopback Redis boundary hold."""
    env = os.environ if environ is None else environ
    if env.get("LOCAL_SIMULATION_ENABLED", "").strip().lower() != "true":
        raise LockLossRefused("LOCAL_SIMULATION_ENABLED != true — refusing (sim-only tool)")
    host = urlparse(redis_url).hostname
    if host not in _LOOPBACK_HOSTS:
        raise LockLossRefused(f"Bridge Redis host {host!r} is not loopback — refusing")


def inject_lock_loss(
    redis_url: str,
    zone_id: str,
    device_id: str,
    action: Literal["delete", "replace"],
    *,
    replacement_ttl_seconds: int = 60,
) -> str:
    """Delete or replace a held device lock so its owner fails the next renewal."""
    assert_simulation_safe(redis_url)
    key = device_lock_key(zone_id, device_id)
    client = redis.Redis.from_url(redis_url, decode_responses=True)
    try:
        if action == "delete":
            changed = client.delete(key) == 1
        elif action == "replace":
            if replacement_ttl_seconds <= 0:
                raise ValueError("replacement TTL must be positive")
            changed = bool(
                client.set(
                    key,
                    _REPLACEMENT_TOKEN,
                    ex=replacement_ttl_seconds,
                    xx=True,
                )
            )
        else:
            raise ValueError(f"unsupported lock-loss action: {action}")
    finally:
        client.close()
    if not changed:
        raise DeviceLockMissing(f"device lock {key!r} is not currently held")
    return key


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("delete", "replace"))
    parser.add_argument("device_id")
    parser.add_argument("--zone-id", help="zone UUID; defaults to BRIDGE_ZONE_ID")
    parser.add_argument(
        "--ttl-seconds",
        type=int,
        default=60,
        help="replacement lock TTL (replace only; default: 60)",
    )
    return parser


def main(argv: list[str]) -> None:
    args = _parser().parse_args(argv)
    settings = get_settings()
    zone_id = args.zone_id or settings.bridge.zone_id
    try:
        key = inject_lock_loss(
            settings.stores.bridge_redis_url,
            zone_id,
            args.device_id,
            args.action,
            replacement_ttl_seconds=args.ttl_seconds,
        )
    except (DeviceLockMissing, LockLossRefused, ValueError) as error:
        raise SystemExit(str(error)) from None
    log.success(f"{args.action} injected for {key}")


if __name__ == "__main__":
    main(sys.argv[1:])
