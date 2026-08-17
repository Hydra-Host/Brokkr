from types import SimpleNamespace

from local import fleet as fleet_mod
from local.derived import managed_tag_for_slot


def test_tag_slot0_legacy():
    assert managed_tag_for_slot(0) == "brokkr-local"


def test_tag_slot2():
    assert managed_tag_for_slot(2) == "brokkr-local-s2"


def _tag_xml(tag: str) -> str:
    return f"<brokkr:managed xmlns:brokkr='https://brokkr.local/sim/v1'>{tag}</brokkr:managed>"


def _fake_virsh(domains: dict[str, str]):
    class _Res:
        def __init__(self, stdout: str):
            self.stdout = stdout

    def _virsh(*args, **_kwargs):
        if args[:3] == ("list", "--all", "--name"):
            return _Res("\n".join(domains))
        if args[0] == "metadata":
            return _Res(domains.get(args[1], ""))
        raise AssertionError(f"unexpected virsh call: {args}")

    return _virsh


def test_tagged_domains_scoped_to_own_tag(monkeypatch):
    domains = {
        "cpu-1": _tag_xml("brokkr-local"),
        "s2-cpu-1": _tag_xml("brokkr-local-s2"),
        "unmanaged": "",
    }
    monkeypatch.setattr(fleet_mod, "virsh", _fake_virsh(domains))
    assert fleet_mod.brokkr_tagged_domains("brokkr-local") == ["cpu-1"]
    assert fleet_mod.brokkr_tagged_domains("brokkr-local-s2") == ["s2-cpu-1"]


def test_tagged_domains_defaults_to_this_slots_tag(monkeypatch):
    domains = {
        "cpu-1": _tag_xml("brokkr-local"),
        "s2-cpu-1": _tag_xml("brokkr-local-s2"),
    }
    monkeypatch.setattr(fleet_mod, "virsh", _fake_virsh(domains))
    monkeypatch.setattr(fleet_mod, "get_settings", lambda: SimpleNamespace(sim=SimpleNamespace(slot=2)))
    assert fleet_mod.brokkr_tagged_domains() == ["s2-cpu-1"]
