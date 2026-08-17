from local import prefetch


class _FakeNode:
    def __init__(self, arch="aarch64", zone=None):
        self.arch = arch
        self.zone = zone


class _FakeFleet:
    def __init__(self, nodes, ordinal_for=None):
        self.nodes = nodes
        self._ordinal_for = ordinal_for or (lambda _zone: 0)

    def zone_port_ordinal(self, zone):
        return self._ordinal_for(zone)


def _inventory(present, arch="arm64"):
    files = [{"name": n, "present": present, "sizeBytes": 1, "mtimeMs": 1} for n in prefetch.REQUIRED_DISCOVERY_FILES]
    return {"architectures": [{"arch": arch, "files": files}]}


def _capture_errors(monkeypatch):
    errors: list[str] = []
    monkeypatch.setattr(prefetch.log, "error", lambda msg, *a, **k: errors.append(msg))
    return errors


def test_passes_silently_when_all_present(monkeypatch):
    errors = _capture_errors(monkeypatch)
    monkeypatch.setattr(prefetch, "_fetch_inventory", lambda url: _inventory(True))
    prefetch.assert_discovery_images_served(_FakeFleet([_FakeNode()]))
    assert errors == []


def test_warns_but_does_not_raise_when_a_file_missing(monkeypatch):
    errors = _capture_errors(monkeypatch)
    monkeypatch.setattr(prefetch, "_fetch_inventory", lambda url: _inventory(False))
    prefetch.assert_discovery_images_served(_FakeFleet([_FakeNode()]))  # no raise, no SystemExit
    assert any("missing" in e for e in errors)
    assert any("VMs will 404 at iPXE" in e for e in errors)


def test_checks_every_arch_in_a_mixed_arch_zone(monkeypatch):
    # both nodes share zone/ordinal 0 but differ in arch; only amd64 is synced.
    calls: list[str] = []

    def fake_fetch(url):
        calls.append(url)
        return {
            "architectures": [
                {"arch": "amd64", "files": [{"name": n, "present": True} for n in prefetch.REQUIRED_DISCOVERY_FILES]}
            ]
        }

    errors = _capture_errors(monkeypatch)
    monkeypatch.setattr(prefetch, "_fetch_inventory", fake_fetch)
    fleet = _FakeFleet([_FakeNode(arch="x86_64"), _FakeNode(arch="aarch64")])
    prefetch.assert_discovery_images_served(fleet)
    # arm64 has no entry in the (amd64-only) inventory → must be reported, proving both arches checked.
    assert any("no arm64 discovery images" in e for e in errors)


def test_unrecognized_arch_is_reported_not_crashing(monkeypatch):
    errors = _capture_errors(monkeypatch)
    monkeypatch.setattr(prefetch, "_fetch_inventory", lambda url: _inventory(True))
    prefetch.assert_discovery_images_served(_FakeFleet([_FakeNode(arch="sparc")]))  # KeyError-safe
    assert any("unrecognized node arch" in e for e in errors)
