"""Bridge cache warm-up: pre-builds per-device ``brokkr-discovery-{device_id}.img`` so iPXE's first
GET at power-on hits the cache instead of stalling on the on-demand build."""

from __future__ import annotations

import json
import time
from pathlib import Path
from subprocess import CalledProcessError
from typing import Protocol
from urllib.parse import urlsplit, urlunsplit

from local.config import get_settings
from local.derived import arch_url_segment
from local.logger import log
from local.process_utils import run
from local.schema import Fleet
from local.zones import http_port


class PrefetchNode(Protocol):
    name: str
    arch: str


def zone_endpoint(port_ordinal: int = 0) -> str:
    """Host-side spoke endpoint for a zone: ``bridge.endpoint`` with the port shifted by the zone's
    spoke-port-block offset ``port_ordinal`` (``Fleet.zone_port_ordinal``; 0 returns it unchanged)."""
    endpoint = get_settings().bridge.endpoint
    if port_ordinal == 0:
        return endpoint
    parsed = urlsplit(endpoint)
    port = http_port(port_ordinal, base=parsed.port or 8000)
    host = parsed.hostname or "127.0.0.1"
    return urlunsplit((parsed.scheme or "http", f"{host}:{port}", parsed.path, parsed.query, parsed.fragment))


def curl_cmd() -> list[str]:
    """Base ``curl`` argv for the discovery-initrd fetch — bounded (3-min cap, 2 retries) so a spoke
    that can't build the image fails fast and loud instead of stalling (the discovery-initrd-deadlock incident)."""
    return [
        "curl",
        "-fS",
        "--max-time",
        "180",
        "--http1.1",
        "--retry",
        "2",
        "--retry-delay",
        "5",
        "--retry-all-errors",
    ]


_UNREACHED_CURL_CODES = frozenset({5, 6, 7})


class SpokeUnreachableError(CalledProcessError):
    """curl never got a connection to the spoke, so nothing is known about what it would serve.
    Subclasses ``CalledProcessError`` so handlers that only care about "the fetch failed" still catch it."""


def _raise_if_unreached(returncode: int, url: str) -> None:
    """Turn a "never reached the server" curl exit into :class:`SpokeUnreachableError`: 5/6 (proxy/host
    resolution) and 7 (connect refused) exchange no bytes with the spoke. 28 (timeout) is deliberately
    NOT one of them — under ``curl_cmd``'s 180s cap it means the spoke answered and then stalled
    building the image (the discovery-initrd-deadlock incident), which must stay fatal."""
    if returncode in _UNREACHED_CURL_CODES:
        raise SpokeUnreachableError(returncode, f"curl {url}")


def remote_size(url: str) -> int | None:
    """HEAD the URL and return Content-Length, or None on any failure — except an unreachable spoke,
    which raises :class:`SpokeUnreachableError` so ``fetch_if_missing`` can bail out before it unlinks."""
    res = run(*curl_cmd(), "-I", url, check=False, capture=True)
    _raise_if_unreached(res.returncode, url)
    if res.returncode != 0:
        return None
    for line in res.stdout.splitlines():
        if line.lower().startswith("content-length:"):
            try:
                return int(line.split(":", 1)[1].strip())
            except ValueError:
                return None
    return None


def fetch_if_missing(url: str, dest: Path) -> None:
    """Download ``url`` to ``dest`` unless the local size is VERIFIED to match. A ``None`` from
    ``remote_size`` (HEAD failed) forces a re-download, not a stale keep (the discovery-initrd-deadlock
    incident). ``remote_size`` raises on an unreachable spoke, which is what keeps the unlink below from
    destroying a good cached image just because the spoke happens to be down."""
    if dest.is_file():
        expected = remote_size(url)
        if expected is not None and dest.stat().st_size == expected:
            return
        dest.unlink(missing_ok=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    res = run(*curl_cmd(), "-o", str(dest), url, check=False)
    _raise_if_unreached(res.returncode, url)
    if res.returncode != 0:
        raise CalledProcessError(res.returncode, f"curl {url}")


def prefetch_node_discovery_initrd(node: PrefetchNode, device_id: str, port_ordinal: int = 0) -> Path:
    """Fetch ``brokkr-discovery-{device_id}.img`` into the node's arch dir, targeting the node's own
    zone spoke via ``port_ordinal`` (the device record lives in that spoke's zone-prefixed Redis namespace)."""
    s = get_settings()
    boot_dir = s.state.boot_artifact_root / node.arch
    target = boot_dir / f"brokkr-discovery-{device_id}.img"
    url = f"{zone_endpoint(port_ordinal)}/api/initrd/brokkr-discovery-{device_id}.img"
    try:
        fetch_if_missing(url, target)
    except SpokeUnreachableError:
        log.warn(
            f"spoke unreachable at {url} — skipped the {target.name} cache warm for {node.name}. "
            "Bring-up continues: the VM fetches this image itself at iPXE boot. Start/health-check the "
            "spoke for that zone, then re-run fleet:init to warm the cache and avoid a first-boot stall."
        )
    except CalledProcessError as e:
        raise RuntimeError(
            f"spoke could not serve {target.name} for {node.name} at {url} — is the spoke building it? ({e})"
        ) from e
    return target


REQUIRED_DISCOVERY_FILES = ("vmlinuz", "initrd.img", "brokkr-discovery.iso")


def _fetch_inventory(url: str) -> dict:
    """GET the bridge discovery inventory as parsed JSON. Bounded (curl_cmd caps time/retries)."""
    res = run(*curl_cmd(), "-s", url, check=False, capture=True)
    if res.returncode != 0:
        raise RuntimeError(f"inventory fetch failed ({url}): rc={res.returncode}")
    return json.loads(res.stdout)


def _spoke_answers(url: str) -> bool:
    """Liveness only, and deliberately NOT curl_cmd(): its --retry 2 --retry-delay 5 makes each failed
    poll cost ~10s, which would make this loop run ~17 minutes while reporting tries * delay."""
    res = run("curl", "-fsS", "--max-time", "3", "--http1.1", "-o", "/dev/null", url, check=False, capture=True)
    return res.returncode == 0


def wait_for_spoke(fleet: Fleet, tries: int = 80, delay: int = 3) -> bool:
    """Block until every zone's spoke answers its discovery inventory, the way sql-seed-run.sh waits on
    the Hub. fleet:init's `after` on the spoke process is inert (devenv launches every process with
    --ignore-process-deps), so without this the images check races a spoke that is still starting."""
    ordinals = sorted({fleet.zone_port_ordinal(n.zone) for n in fleet.nodes})
    pending = [f"{zone_endpoint(o)}/api/discovery/inventory" for o in ordinals]
    started = time.monotonic()
    for attempt in range(tries):
        pending = [u for u in pending if not _spoke_answers(u)]
        if not pending:
            return True
        if attempt == 0:
            log.info(f"waiting for the spoke at {', '.join(pending)}…")
        elif attempt % 10 == 0:
            log.info(f"still waiting for the spoke ({int(time.monotonic() - started)}s)…")
        time.sleep(delay)
    waited = int(time.monotonic() - started)
    for url in pending:
        log.error(f"spoke did not answer {url} after {waited}s — is the spoke process running?")
    return False


def assert_discovery_images_served(fleet: Fleet) -> None:
    """Warn (loudly) if the spoke isn't serving the host-arch discovery images, but do NOT abort — an
    offline network shouldn't block ``task up``, and SystemExit would escape @_records_failure. Dedup
    keyed on (zone ordinal, arch) so every arch in a mixed-arch zone is checked."""
    checked: set[tuple[int, str]] = set()
    missing_reports: list[str] = []
    unreachable_reports: list[str] = []
    for node in fleet.nodes:
        ordinal = fleet.zone_port_ordinal(node.zone)
        try:
            want_arch = arch_url_segment(node.arch)
        except KeyError:
            key = (ordinal, f"?{node.arch}")
            if key not in checked:
                checked.add(key)
                missing_reports.append(f"zone ordinal {ordinal}: unrecognized node arch {node.arch!r}")
            continue
        key = (ordinal, want_arch)
        if key in checked:
            continue
        checked.add(key)
        url = f"{zone_endpoint(ordinal)}/api/discovery/inventory"
        try:
            inv = _fetch_inventory(url)
            arch_entry = next((a for a in inv.get("architectures", []) if a.get("arch") == want_arch), None)
            if arch_entry is None:
                missing_reports.append(f"zone ordinal {ordinal}: no {want_arch} discovery images at {url}")
                continue
            by_name = {f.get("name"): f for f in arch_entry.get("files", []) if isinstance(f, dict)}
            missing = [n for n in REQUIRED_DISCOVERY_FILES if not by_name.get(n, {}).get("present")]
        except Exception as e:  # malformed/unreachable inventory means "not serving": report it
            unreachable_reports.append(f"zone ordinal {ordinal}: could not read {url} ({e})")
            continue
        if missing:
            missing_reports.append(f"zone ordinal {ordinal} ({want_arch}): missing {', '.join(missing)}")

    if unreachable_reports:
        for r in unreachable_reports:
            log.error(r)
        log.error(
            "the spoke is not answering — nothing can be said about the discovery images yet. This is "
            "the spoke process being down or still starting, not an asset-origin problem: check the "
            "spoke in the control center (Stack → spoke) or `task logs`. Continuing bring-up anyway — "
            "the fleet won't PXE-boot until the spoke is up."
        )
    if missing_reports:
        for r in missing_reports:
            log.error(r)
        log.error(
            "spoke is not serving the discovery images — VMs will 404 at iPXE. The spoke's "
            "bridge_sync could not download them from the public asset origin it is pointed at "
            "(DISCOVERY_BASE_URL, derived from the devenv knob osLayerCache.originHost). Confirm "
            "that host is reachable from here, then re-sync (control center Storage → re-sync, or "
            "restart the spoke). Continuing bring-up anyway — the fleet won't PXE-boot until this "
            "is resolved."
        )
