from __future__ import annotations

from local.hub_client import HubClient


def test_deprovision_issues_delete_with_mutation_timeout(monkeypatch):
    calls: list[tuple] = []

    def fake_request(self, method, path, body=None, *, timeout=30):
        calls.append((method, path, body, timeout))
        return 200, None

    monkeypatch.setattr(HubClient, "_request", fake_request)

    client = HubClient()
    code, _ = client.deprovision("dep-123")

    assert code == 200
    assert calls == [("DELETE", "/api/v1/deployments/dep-123/deprovision", None, HubClient._MUTATION_TIMEOUT)]


def test_force_discovery_posts_collect_inventory_with_mutation_timeout(monkeypatch):
    calls: list[tuple] = []

    def fake_request(self, method, path, body=None, *, timeout=30):
        calls.append((method, path, body, timeout))
        return 200, {"jobId": "job-1"}

    monkeypatch.setattr(HubClient, "_request", fake_request)

    client = HubClient()
    code, body = client.force_discovery("dev-123")

    assert code == 200
    assert body == {"jobId": "job-1"}
    assert calls == [("POST", "/api/v1/servers/dev-123/collect-inventory", {}, HubClient._MUTATION_TIMEOUT)]
