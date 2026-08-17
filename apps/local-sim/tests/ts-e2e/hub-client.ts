/**
 * Authenticated client for the Hub main API (:3000).
 *
 * TypeScript port of `scripts/local/admin_api.py`. Uses plain `fetch` with
 * manual cookie persistence (no ts-rest, no external HTTP libs) since this is
 * test tooling.
 *
 * Auth is the hardcoded sim user (`brokkr@brokkr.local` / `brokkr`), which the
 * Hub bootstraps when `AUTH_BYPASS_ENABLED=true` or `LOCAL_SIMULATION_ENABLED=true`.
 *
 * Lifecycle mutations that operate on deployments (reprovision, reboot, rescue,
 * deprovision) require a deployment ID, not a device ID. Callers must resolve the
 * active deployment before calling those methods.
 */

export const SIM_ADMIN_EMAIL = 'brokkr@brokkr.local';
export const SIM_ADMIN_PASSWORD = 'brokkr';
export const SIM_ORG_ID = '00000000-0000-0000-0000-000000000000';

export interface HubResponse {
  status: number;
  body: unknown;
}

/**
 * The Hub API didn't answer (connection refused / timeout / DNS).
 *
 * Almost always means the stack isn't up yet -- bring up the hub (Stack ->
 * datastores + hub) before anything that reads Hub state.
 */
export class HubUnreachable extends Error {
  constructor(baseUrl: string, cause?: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `Hub API not reachable at ${baseUrl} (${reason}). ` +
        'Is the stack up? Bring up the hub first (Stack -> datastores + hub).',
    );
    this.name = 'HubUnreachable';
  }
}

/**
 * Minimal cookie jar that captures `set-cookie` headers and replays them.
 *
 * Only handles the simple case needed for same-origin auth cookies --
 * no domain/path/expiry matching, no Secure/HttpOnly enforcement.
 */
class CookieJar {
  private cookies = new Map<string, string>();

  /** Extract cookies from a fetch Response. */
  capture(response: Response): void {
    // `response.headers.getSetCookie()` returns one string per Set-Cookie header.
    const setCookieHeaders = response.headers.getSetCookie?.();
    if (setCookieHeaders) {
      for (const header of setCookieHeaders) {
        this.parseSetCookie(header);
      }
    }
  }

  /** Build the `Cookie` header value. */
  toString(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private parseSetCookie(header: string): void {
    // The cookie key=value is the first segment before any `;`.
    const firstSemi = header.indexOf(';');
    const kvPart = firstSemi === -1 ? header : header.slice(0, firstSemi);
    const eqIdx = kvPart.indexOf('=');
    if (eqIdx === -1) return;
    const name = kvPart.slice(0, eqIdx).trim();
    const value = kvPart.slice(eqIdx + 1).trim();
    if (name) {
      this.cookies.set(name, value);
    }
  }
}

export class HubAdminClient {
  private readonly baseUrl: string;
  private readonly jar = new CookieJar();
  private static readonly MUTATION_TIMEOUT_MS = 120_000;
  private static readonly DEFAULT_TIMEOUT_MS = 30_000;

  constructor(baseUrl = process.env.SIM_HUB_URL ?? 'http://127.0.0.1:3000') {
    this.baseUrl = baseUrl;
  }

  private async request(
    method: string,
    path: string,
    body?: object,
    timeoutMs = HubAdminClient.DEFAULT_TIMEOUT_MS,
  ): Promise<HubResponse> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const cookieStr = this.jar.toString();
    if (cookieStr) {
      headers['Cookie'] = cookieStr;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        // Prevent fetch from following redirects so we can capture cookies
        // from intermediate responses. In practice the Hub API doesn't
        // redirect, but this mirrors urllib's default behavior.
        redirect: 'manual',
      });
    } catch (error: unknown) {
      // Connection refused, DNS failure, timeout
      throw new HubUnreachable(this.baseUrl, error);
    }

    this.jar.capture(response);

    const raw = await response.text();
    let parsed: unknown = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { raw };
      }
    }

    return { status: response.status, body: parsed };
  }

  /** Sign in as the sim admin user and set the active organization. */
  async signIn(): Promise<void> {
    const signInResult = await this.request('POST', '/api/v1/auth/sign-in/email', {
      email: SIM_ADMIN_EMAIL,
      password: SIM_ADMIN_PASSWORD,
    });

    if (signInResult.status !== 200) {
      const hint =
        signInResult.status >= 500 ? ' -- hub DB likely unavailable; bring the stack up (datastores + hub)' : '';
      throw new Error(`sign-in failed (${signInResult.status}): ${JSON.stringify(signInResult.body)}${hint}`);
    }

    const setOrgResult = await this.request('POST', `/api/v1/organizations/${SIM_ORG_ID}/set-active`, {});

    if (setOrgResult.status !== 200) {
      throw new Error(`set-active-org failed (${setOrgResult.status}): ${JSON.stringify(setOrgResult.body)}`);
    }
  }

  /** POST /api/v1/zones — body per CreateZoneRequestSchema. */
  async createZone(body: object): Promise<HubResponse> {
    return this.request('POST', '/api/v1/zones', body);
  }

  /** DELETE /api/v1/zones/{zoneId} (soft delete; revokes the Redis ACL user when enabled). */
  async deleteZone(zoneId: string): Promise<HubResponse> {
    return this.request('DELETE', `/api/v1/zones/${zoneId}`);
  }

  /** POST /api/v1/zones/{zoneId}/redis-credential/rotate — show-once credential. */
  async rotateZoneRedisCredential(zoneId: string): Promise<HubResponse> {
    return this.request('POST', `/api/v1/zones/${zoneId}/redis-credential/rotate`, {});
  }

  /** GET /api/v1/servers/{deviceId} */
  async getServer(deviceId: string): Promise<HubResponse> {
    return this.request('GET', `/api/v1/servers/${deviceId}`);
  }

  /** PATCH /api/v1/servers/{deviceId}/provision */
  async provision(deviceId: string, payload: object): Promise<HubResponse> {
    return this.request('PATCH', `/api/v1/servers/${deviceId}/provision`, payload, HubAdminClient.MUTATION_TIMEOUT_MS);
  }

  /**
   * POST /api/v1/servers/{deviceId}/collect-inventory — force an inventory_collection
   * saga (cooldown-agnostic; the bridge auto-collect 3600s cooldown does not gate this
   * hub-driven path). Bare-metal needs a live collection to populate the eth0 IpAddress
   * + Server.storageLayouts a VM gets from static seed. Idempotent: coalesces per device.
   */
  async collectInventory(deviceId: string): Promise<HubResponse> {
    return this.request('POST', `/api/v1/servers/${deviceId}/collect-inventory`, {});
  }

  /** Reprovision via deployment ID (main API is deployment-scoped). */
  async reprovision(deploymentId: string, payload: object): Promise<HubResponse> {
    return this.request(
      'PATCH',
      `/api/v1/deployments/${deploymentId}/reprovision`,
      payload,
      HubAdminClient.MUTATION_TIMEOUT_MS,
    );
  }

  /** Power-cycle via deployment ID. */
  async reboot(deploymentId: string): Promise<HubResponse> {
    return this.request('PATCH', `/api/v1/deployments/${deploymentId}/reboot`, {}, HubAdminClient.MUTATION_TIMEOUT_MS);
  }

  /** Boot into rescue OS via deployment ID. */
  async rescueActivate(deploymentId: string, rescueOs?: string): Promise<HubResponse> {
    return this.request(
      'POST',
      `/api/v1/deployments/${deploymentId}/rescue-mode/activate`,
      rescueOs ? { rescueOs } : {},
      HubAdminClient.MUTATION_TIMEOUT_MS,
    );
  }

  /** Exit rescue mode via deployment ID. */
  async rescueDeactivate(deploymentId: string): Promise<HubResponse> {
    return this.request(
      'POST',
      `/api/v1/deployments/${deploymentId}/rescue-mode/deactivate`,
      {},
      HubAdminClient.MUTATION_TIMEOUT_MS,
    );
  }

  /** Commission a discovered device. */
  async commissionDiscoveredDevice(params: {
    id: string;
    macAddress: string;
    ipmiLogin: string;
    ipmiPassword: string;
  }): Promise<HubResponse> {
    return this.request(
      'POST',
      '/api/v1/servers/commission',
      {
        id: params.id,
        macAddress: params.macAddress,
        ipmiLogin: params.ipmiLogin,
        ipmiPassword: params.ipmiPassword,
      },
      HubAdminClient.MUTATION_TIMEOUT_MS,
    );
  }

  /** Deprovision via deployment ID (main API combines end-rental + deprovision). */
  async endRental(deploymentId: string): Promise<HubResponse> {
    return this.request(
      'DELETE',
      `/api/v1/deployments/${deploymentId}/deprovision`,
      undefined,
      HubAdminClient.MUTATION_TIMEOUT_MS,
    );
  }

  /** Standalone deprovision via deployment ID. */
  async deprovision(deploymentId: string): Promise<HubResponse> {
    return this.request(
      'DELETE',
      `/api/v1/deployments/${deploymentId}/deprovision`,
      undefined,
      HubAdminClient.MUTATION_TIMEOUT_MS,
    );
  }
}
