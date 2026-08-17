import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Injectable, Optional } from '@nestjs/common';

import { FleetProgressSchema, type FleetProgress } from '../common/pc-schemas';
import type { Machine } from '../contract';
import { deriveFleetStatus, type FleetStatus } from '../services/fleet-health';
import type { PcProcess } from '../services/proc-health';
import { ProcessComposeClient } from '../services/process-compose.client';
import { FleetPowerService } from './fleet-power.service';
import { FleetTopologyService } from './fleet-topology.service';

export function fleetProgressPath(): string {
  const root = process.env.LOCAL_STATE || join(homedir(), '.local/share/local');
  return join(root, 'state/run/fleet-progress.json');
}

export interface ProgressReader {
  readProgress(): FleetProgress | null;
}

@Injectable()
export class FleetStatusService {
  constructor(
    private readonly pc: ProcessComposeClient,
    private readonly topology: FleetTopologyService,
    private readonly power: FleetPowerService,
    @Optional() private readonly reader: ProgressReader = { readProgress: FleetStatusService.readProgressFromDisk },
  ) {}

  static readProgressFromDisk(): FleetProgress | null {
    const path = fleetProgressPath();
    if (!existsSync(path)) return null;
    try {
      // validate the untrusted disk JSON at the boundary; a malformed/partial file → null (no progress).
      return FleetProgressSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      return null;
    }
  }

  async status(machines?: Machine[]): Promise<FleetStatus> {
    let fleetProc: PcProcess | undefined;
    try {
      fleetProc = (await this.pc.listAll()).find((p) => p.name === 'fleet');
    } catch {
      fleetProc = undefined;
    }
    const expected = this.topology.nodeNames();
    const list = machines ?? (await this.power.machines().catch(() => []));
    const running = list.filter((m) => m.configured && m.power === 'on');
    const prog = this.reader.readProgress();
    const status = (fleetProc?.status ?? '').toLowerCase();
    const terminal = !!fleetProc && !['running', 'pending', 'disabled'].includes(status);
    const lastError =
      terminal && !prog?.error ? (this.pc.tailError('fleet') ?? this.pc.tailTaskLog('fleet:init')) : undefined;
    return deriveFleetStatus(fleetProc, prog, expected.length, running.length, Date.now(), lastError);
  }
}
