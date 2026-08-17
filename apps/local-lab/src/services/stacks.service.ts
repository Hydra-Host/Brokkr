import { existsSync } from 'node:fs';

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { StacksList } from '../contract';
import { STACK_SLOT } from '../ports';
import { ProcessComposeClient, procIsUp } from './process-compose.client';
import { StackRegistryClient, type StackEntry } from './stack-registry-client';

const EntryPortsSchema = z.object({
  hubApi: z.object({ base: z.number() }).passthrough(),
  hubWeb: z.number(),
  lab: z.number(),
  labWeb: z.number(),
});

export interface StackProbeResult {
  live: boolean;
  running: number;
  total: number;
}

const StatusSummarySchema = z
  .object({
    datastores: z.object({ postgres: z.boolean(), redis: z.boolean() }).partial(),
    fleetSummary: z.object({ on: z.number(), total: z.number() }).partial().nullable().optional(),
  })
  .partial();

export type StackProbe = (entry: StackEntry) => Promise<StackProbeResult>;

export const NOT_LIVE: StackProbeResult = { live: false, running: 0, total: 0 };

/** A sibling's /api/status is measured at 1–4s on an idle host, so the deadline has to clear its slow
 *  tail or the health line becomes a coin-flip; the cache keeps that cost off every dashboard poll. */
const HEALTH_TIMEOUT_MS = 5_000;
const HEALTH_CACHE_MS = 10_000;

/** One-line health rollup from a sibling stack's own status snapshot; null when the sibling's lab
 *  doesn't answer (live-but-unhealthy shows the process rollup instead). */
async function fetchHealthLine(labUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${labUrl}/api/status`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const status = StatusSummarySchema.parse(await res.json());
    const pg = status.datastores?.postgres ? 'pg up' : 'pg down';
    const redis = status.datastores?.redis ? 'up' : 'down';
    const fleet = status.fleetSummary ? ` · fleet ${status.fleetSummary.on}/${status.fleetSummary.total} on` : '';
    return `${pg} · redis ${redis}${fleet}`;
  } catch {
    return null;
  }
}

/** Liveness is the socket answering, never the registry row — the row is a hint, pc.sock is truth. */
export const socketProbe =
  (pc: ProcessComposeClient): StackProbe =>
  async (entry) => {
    const sock = entry.pcSock;
    if (!sock || !existsSync(sock)) return NOT_LIVE;
    try {
      const procs = await pc.listOnSocket(sock);
      const active = procs.filter((p) => p.status.toLowerCase() !== 'disabled');
      return { live: true, running: active.filter(procIsUp).length, total: active.length };
    } catch {
      return NOT_LIVE;
    }
  };

@Injectable()
export class StacksService {
  private readonly healthLines = new Map<string, { line: string | null; at: number }>();

  constructor(
    private readonly registry: StackRegistryClient,
    private readonly probe: StackProbe,
  ) {}

  async listStacks(): Promise<StacksList> {
    const stacks = await Promise.all(
      this.registry.list().map(async (entry) => {
        // an entry the registry's own staleness rule has reclaimed is flat not-live — never probed
        const probe = (await this.registry.ownerOfSlot(entry.slot)) === null ? NOT_LIVE : await this.probe(entry);
        const parsed = EntryPortsSchema.safeParse(entry.ports);
        const ports = parsed.success ? parsed.data : null;
        const labUrl = ports ? `http://localhost:${ports.lab}` : null;
        return {
          slot: entry.slot,
          checkout: entry.checkout,
          state: entry.state ?? 'unknown',
          live: probe.live,
          hubUrl: ports ? `http://localhost:${ports.hubApi.base}` : null,
          webUrl: ports ? `http://localhost:${ports.hubWeb}` : null,
          labUrl,
          labWebUrl: ports ? `http://localhost:${ports.labWeb}` : null,
          processes: { running: probe.running, total: probe.total },
          healthLine: probe.live && labUrl ? await this.healthLine(labUrl) : null,
        };
      }),
    );
    return { stacks, selfSlot: STACK_SLOT };
  }

  private async healthLine(labUrl: string): Promise<string | null> {
    const cached = this.healthLines.get(labUrl);
    if (cached && Date.now() - cached.at < HEALTH_CACHE_MS) return cached.line;
    const line = await fetchHealthLine(labUrl);
    this.healthLines.set(labUrl, { line, at: Date.now() });
    return line;
  }
}
