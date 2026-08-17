"""Authenticated client for the Hub main API (:3000), auth'd as the hardcoded sim user.

Deployment-scoped mutations (reprovision, reboot, rescue, deprovision) take a deployment ID,
not a device ID — callers resolve the active deployment first.
"""

from __future__ import annotations

import http.cookiejar
import json
import urllib.error
import urllib.request

from local.config import get_settings

SIM_ADMIN_EMAIL = "brokkr@brokkr.local"
SIM_ADMIN_PASSWORD = "brokkr"
SIM_ORG_ID = "00000000-0000-0000-0000-000000000000"


class HubUnreachable(RuntimeError):
    """The Hub API didn't answer — almost always means the stack isn't up yet."""


class HubClient:
    def __init__(self, base_url: str | None = None):
        self.base_url = base_url if base_url is not None else get_settings().hub.endpoint
        self._jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self._jar))

    def _request(
        self, method: str, path: str, body: dict | None = None, *, timeout: float = 30
    ) -> tuple[int, dict | None]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            headers={"Content-Type": "application/json"},
            method=method,
        )
        try:
            resp = self._opener.open(req, timeout=timeout)
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, (json.loads(raw) if raw else None)
            except ValueError:
                return e.code, {"raw": raw.decode(errors="replace")}
        except urllib.error.URLError as e:
            raise HubUnreachable(
                f"Hub API not reachable at {self.base_url} ({e.reason}). "
                "Is the stack up? Bring up the hub first (Stack → datastores + hub)."
            ) from None

    def sign_in(self) -> None:
        code, body = self._request(
            "POST",
            "/api/v1/auth/sign-in/email",
            {"email": SIM_ADMIN_EMAIL, "password": SIM_ADMIN_PASSWORD},
        )
        if code != 200:
            hint = " — hub DB likely unavailable; bring the stack up (datastores + hub)" if code >= 500 else ""
            raise RuntimeError(f"sign-in failed ({code}): {body}{hint}")
        code, body = self._request(
            "POST",
            f"/api/v1/organizations/{SIM_ORG_ID}/set-active",
            {},
        )
        if code != 200:
            raise RuntimeError(f"set-active-org failed ({code}): {body}")

    def get_server(self, device_id: str) -> tuple[int, dict | None]:
        """Device detail from the main API (layer catalog data not included)."""
        return self._request("GET", f"/api/v1/servers/{device_id}")

    _MUTATION_TIMEOUT = 120

    def provision(self, device_id: str, payload: dict) -> tuple[int, dict | None]:
        return self._request(
            "PATCH",
            f"/api/v1/servers/{device_id}/provision",
            payload,
            timeout=self._MUTATION_TIMEOUT,
        )

    def reprovision(self, deployment_id: str, payload: dict) -> tuple[int, dict | None]:
        """Reprovision via deployment ID (main API is deployment-scoped)."""
        return self._request(
            "PATCH",
            f"/api/v1/deployments/{deployment_id}/reprovision",
            payload,
            timeout=self._MUTATION_TIMEOUT,
        )

    def reboot(self, deployment_id: str) -> tuple[int, dict | None]:
        """Power-cycle via deployment ID."""
        return self._request(
            "PATCH",
            f"/api/v1/deployments/{deployment_id}/reboot",
            {},
            timeout=self._MUTATION_TIMEOUT,
        )

    def force_discovery(self, device_id: str) -> tuple[int, dict | None]:
        """Enqueue inventory_collection (coalesced per device, async saga); 200 body is ``{"jobId": <str>}``."""
        return self._request(
            "POST",
            f"/api/v1/servers/{device_id}/collect-inventory",
            {},
            timeout=self._MUTATION_TIMEOUT,
        )

    def rescue_activate(self, deployment_id: str, rescue_os: str | None = None) -> tuple[int, dict | None]:
        """Boot into rescue OS via deployment ID."""
        return self._request(
            "POST",
            f"/api/v1/deployments/{deployment_id}/rescue-mode/activate",
            {"rescueOs": rescue_os} if rescue_os else {},
            timeout=self._MUTATION_TIMEOUT,
        )

    def rescue_deactivate(self, deployment_id: str) -> tuple[int, dict | None]:
        """Exit rescue mode via deployment ID."""
        return self._request(
            "POST",
            f"/api/v1/deployments/{deployment_id}/rescue-mode/deactivate",
            {},
            timeout=self._MUTATION_TIMEOUT,
        )

    def commission_zone_devices(self, zone_id: str, devices: list[dict]) -> tuple[int, dict | None]:
        return self._request(
            "POST",
            f"/api/v1/zones/{zone_id}/commissioning/commission",
            {"devices": devices},
            timeout=self._MUTATION_TIMEOUT,
        )

    def commissioning_progress(self, zone_id: str) -> tuple[int, dict | None]:
        return self._request("GET", f"/api/v1/zones/{zone_id}/commissioning/progress")

    def acknowledge_commissioning(self, zone_id: str, device_id: str) -> tuple[int, dict | None]:
        return self._request(
            "POST",
            f"/api/v1/zones/{zone_id}/commissioning/progress/{device_id}/acknowledge",
            {},
            timeout=self._MUTATION_TIMEOUT,
        )

    def deprovision(self, deployment_id: str) -> tuple[int, dict | None]:
        """Deprovision via deployment ID (the main API combines end-rental + deprovision)."""
        return self._request(
            "DELETE",
            f"/api/v1/deployments/{deployment_id}/deprovision",
            timeout=self._MUTATION_TIMEOUT,
        )
