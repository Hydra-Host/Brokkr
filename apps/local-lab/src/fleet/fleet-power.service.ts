import { BadRequestException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Agent, request } from 'undici';

import { type BareMetalPowerAction } from '@repo/local-lab-contract';
import { getErrorMessage } from '../common/errors';
import { simDeviceUuid } from '../common/hub-client';
import type { Machine } from '../contract';
import { STACK_SLOT } from '../ports';
import type { RunState } from '../runner/runner.service';
import { RunnerService } from '../runner/runner.service';
import { OverlayStoreService } from '../services/overlay-store';
import { FleetOpRegistry } from './fleet-op-registry';
import { FleetTopologyService } from './fleet-topology.service';
import { managedTagForSlot } from './managed-tag';

const execFileP = promisify(execFile);

const LIBVIRT_URI =
  process.env.LOCAL_BROKKR_LIBVIRT_URI ?? (process.platform === 'darwin' ? 'qemu:///session' : 'qemu:///system');

// one user-session libvirt serves every stack on the host, so a wedged daemon would otherwise stall
// GET /api/status for as long as it takes to recover.
const VIRSH_TIMEOUT_MS = 5_000;

const REDFISH_VERB: Record<string, string> = { on: 'power-on', off: 'power-off', cycle: 'power-cycle' };

export class RedfishError extends Error {}

const RESET_TYPES: Record<BareMetalPowerAction, string[]> = {
  on: ['On'],
  off: ['ForceOff', 'GracefulShutdown'],
  reset: ['ForceRestart', 'GracefulRestart'],
  powercycle: ['PowerCycle', 'ForceRestart'],
};

@Injectable()
export class FleetPowerService {
  private readonly log = new Logger(FleetPowerService.name);

  constructor(
    private readonly runner: RunnerService,
    private readonly overlay: OverlayStoreService,
    private readonly topology: FleetTopologyService,
    private readonly opRegistry: FleetOpRegistry,
  ) {}

  async baremetalPower(
    name: string,
    action: BareMetalPowerAction,
  ): Promise<{ powerState: string; action: BareMetalPowerAction; resetType: string }> {
    if (this.overlay.fleetMode() !== 'baremetal')
      throw new BadRequestException('bare-metal power is only available in bare-metal mode');
    if (this.topology.hostFacts().os !== 'linux')
      throw new BadRequestException('bare-metal power requires a Linux host');
    const node = this.topology.baremetalView().nodes.find((n) => n.name === name);
    if (!node) throw new NotFoundException(`unknown bare-metal machine '${name}'`);
    const cred = this.topology.resolveBmcCred(name);
    if (!cred) throw new BadRequestException(`no BMC credentials configured for '${name}'`);

    const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    const base = `https://${node.bmc_ip}`;
    const auth = 'Basic ' + Buffer.from(`${cred.user}:${cred.pass}`).toString('base64');
    const headers = { authorization: auth, 'content-type': 'application/json' };
    const powercycleFallback = action === 'powercycle';
    try {
      const systemPath = await this.resolveRedfishSystem(base, headers, dispatcher, node.system_id);
      const allowable = await this.redfishAllowableResetTypes(base, systemPath, headers, dispatcher);
      const resetType = RESET_TYPES[action].find((t) => allowable.length === 0 || allowable.includes(t));
      if (!resetType) {
        if (powercycleFallback && (allowable.length === 0 || allowable.includes('ForceOff'))) {
          await this.redfishReset(base, systemPath, 'ForceOff', headers, dispatcher);
          await this.pollPowerState(base, systemPath, headers, dispatcher, 'Off', 30_000, 2_000);
          await this.redfishReset(base, systemPath, 'On', headers, dispatcher);
          const powerState = await this.redfishPowerState(base, systemPath, headers, dispatcher);
          return { powerState, action, resetType: 'ForceOff+On' };
        }
        throw new BadRequestException(
          `BMC does not support ${action} (allowable: ${allowable.join(', ') || 'unknown'})`,
        );
      }
      await this.redfishReset(base, systemPath, resetType, headers, dispatcher);
      const powerState = await this.redfishPowerState(base, systemPath, headers, dispatcher);
      this.log.log(`bare-metal power: ${name} ${action} → ${resetType} (state=${powerState})`);
      return { powerState, action, resetType };
    } catch (e) {
      // Plain transport errors would bypass RedfishExceptionFilter as opaque 500s — remap to the 502
      // BMC shape; message carries bmc_ip + cause only, never base/headers (Basic-auth credential).
      if (e instanceof RedfishError || e instanceof HttpException) throw e;
      throw new RedfishError(`BMC ${node.bmc_ip} unreachable: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      void dispatcher.close();
    }
  }

  private async redfishGet(
    base: string,
    path: string,
    headers: Record<string, string>,
    dispatcher: Agent,
  ): Promise<Record<string, unknown>> {
    const res = await request(`${base}${path}`, { method: 'GET', headers, dispatcher });
    const text = await res.body.text();
    if (res.statusCode >= 400) throw new RedfishError(`GET ${path} → ${res.statusCode}: ${text.slice(0, 200)}`);
    let json: unknown = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new RedfishError(`GET ${path} → non-JSON body: ${text.slice(0, 200)}`);
      }
    }
    return json !== null && typeof json === 'object' ? { ...json } : {};
  }

  private async resolveRedfishSystem(
    base: string,
    headers: Record<string, string>,
    dispatcher: Agent,
    systemId: string | null,
  ): Promise<string> {
    if (systemId) return `/redfish/v1/Systems/${systemId}`;
    const body = await this.redfishGet(base, '/redfish/v1/Systems', headers, dispatcher);
    const members = body.Members;
    const first = Array.isArray(members) ? members[0] : undefined;
    const ref = first && typeof first === 'object' && '@odata.id' in first ? first['@odata.id'] : undefined;
    if (typeof ref !== 'string') throw new RedfishError('no ComputerSystem found under /redfish/v1/Systems');
    return ref;
  }

  private async redfishAllowableResetTypes(
    base: string,
    systemPath: string,
    headers: Record<string, string>,
    dispatcher: Agent,
  ): Promise<string[]> {
    const sys = await this.redfishGet(base, systemPath, headers, dispatcher);
    const actions = sys.Actions;
    const reset =
      actions && typeof actions === 'object' && '#ComputerSystem.Reset' in actions
        ? actions['#ComputerSystem.Reset']
        : undefined;
    const allowed =
      reset && typeof reset === 'object' && 'ResetType@Redfish.AllowableValues' in reset
        ? reset['ResetType@Redfish.AllowableValues']
        : undefined;
    return Array.isArray(allowed) ? allowed.filter((v): v is string => typeof v === 'string') : [];
  }

  private async redfishReset(
    base: string,
    systemPath: string,
    resetType: string,
    headers: Record<string, string>,
    dispatcher: Agent,
  ): Promise<void> {
    const res = await request(`${base}${systemPath}/Actions/ComputerSystem.Reset`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ResetType: resetType }),
      dispatcher,
    });
    const text = await res.body.text();
    if (res.statusCode >= 400) throw new RedfishError(`Reset ${resetType} → ${res.statusCode}: ${text.slice(0, 200)}`);
  }

  private async redfishPowerState(
    base: string,
    systemPath: string,
    headers: Record<string, string>,
    dispatcher: Agent,
  ): Promise<string> {
    const sys = await this.redfishGet(base, systemPath, headers, dispatcher);
    return typeof sys.PowerState === 'string' ? sys.PowerState : 'Unknown';
  }

  private async pollPowerState(
    base: string,
    systemPath: string,
    headers: Record<string, string>,
    dispatcher: Agent,
    want: string,
    budgetMs: number,
    stepMs: number,
  ): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if ((await this.redfishPowerState(base, systemPath, headers, dispatcher)) === want) return;
      await new Promise((r) => setTimeout(r, stepMs));
    }
    throw new RedfishError(`timed out waiting for power state '${want}' after ${budgetMs}ms`);
  }

  private powerStates(): Promise<Map<string, 'on' | 'off' | 'unknown'>> {
    return new Promise((resolve) => {
      let out = '';
      const c = spawn('virsh', ['-c', LIBVIRT_URI, 'list', '--all'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: VIRSH_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      c.stdout.on('data', (b) => (out += b.toString()));
      c.on('error', () => resolve(new Map()));
      c.on('close', () => {
        const map = new Map<string, 'on' | 'off' | 'unknown'>();
        for (const line of out.split('\n')) {
          const m = line.match(/^\s*\S+\s+(\S+)\s+(.+?)\s*$/);
          if (!m || m[1] === 'Name') continue;
          const state = m[2].trim();
          map.set(m[1], state === 'running' ? 'on' : state.startsWith('shut') ? 'off' : 'unknown');
        }
        resolve(map);
      });
    });
  }

  private static readonly BROKKR_NS = 'https://brokkr.local/sim/v1';

  private isBrokkrManaged(name: string): Promise<boolean> {
    return new Promise((resolve) => {
      let out = '';
      const c = spawn('virsh', ['-c', LIBVIRT_URI, 'metadata', name, '--uri', FleetPowerService.BROKKR_NS], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: VIRSH_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      c.stdout.on('data', (b) => (out += b.toString()));
      c.on('error', () => resolve(false));
      // the >tag< framing stops slot 0's 'brokkr-local' from matching a sibling slot's 'brokkr-local-sN'.
      c.on('close', () => resolve(out.includes(`>${managedTagForSlot(STACK_SLOT)}<`)));
    });
  }

  async machines(): Promise<Machine[]> {
    const [names, states] = await Promise.all([Promise.resolve(this.topology.nodeNames()), this.powerStates()]);
    const configured: Machine[] = names.map((name, index) => ({
      name,
      power: states.get(name) ?? 'unknown',
      configured: true,
      deviceId: simDeviceUuid(index),
    }));
    const orphanCandidates = [...states.entries()].filter(([n]) => !names.includes(n));
    const orphanFlags = await Promise.all(orphanCandidates.map(([n]) => this.isBrokkrManaged(n)));
    const orphans: Machine[] = orphanCandidates
      .filter((_, i) => orphanFlags[i])
      .map(([name, power]) => ({ name, power, configured: false, deviceId: null }));
    return [...configured, ...orphans];
  }

  power(name: string, action: string): string {
    if (!this.topology.nodeNames().includes(name)) throw new NotFoundException(`unknown node '${name}'`);
    const verb = REDFISH_VERB[action];
    if (!verb) throw new NotFoundException(`unknown power action '${action}'`);
    // acquire before runner.create so a 409 never leaves an orphan run behind.
    const lease = this.opRegistry.acquire({ kind: 'node', name }, `power ${name} ${action}`);
    let run: RunState;
    try {
      run = this.runner.create({ section: 'fleet', opId: 'power', label: `power ${name} ${action}` });
      lease.bind(run.runId);
    } catch (e) {
      lease.release();
      throw e;
    }
    this.log.log(`fleet power: ${name} ${verb}`);
    void this.runPower(run, name, action, verb)
      .catch((e) => {
        this.runner.emit(run, `\r\n[power] error: ${getErrorMessage(e)}\r\n`);
        this.runner.finalize(run, 1);
      })
      .finally(() => lease.release());
    return run.runId;
  }

  private async runPower(run: RunState, name: string, action: string, verb: string): Promise<void> {
    const bmc = await this.runner.spawn(run, 'bash', ['scripts/tasks/redfish.sh', name, verb]);
    if (bmc !== 0)
      this.runner.emit(run, `\n[power] BMC ${verb} exited ${bmc ?? 'null'} — verifying and enforcing via virsh\n`);
    const want: 'on' | 'off' = action === 'off' ? 'off' : 'on';
    if (await this.awaitPowerState(name, want)) return this.runner.finalize(run, 0);
    this.runner.emit(run, `\n[power] ${name} is not '${want}' after the BMC ${verb} — enforcing via virsh\n`);
    const args = want === 'off' ? ['destroy', name] : ['start', name];
    const code = await this.runner.spawn(run, 'virsh', ['-c', LIBVIRT_URI, ...args]);
    // A "domain already active/shut off" race is not a real failure — re-check the actual state.
    if (code !== 0 && (await this.awaitPowerState(name, want))) return this.runner.finalize(run, 0);
    return this.runner.finalize(run, code);
  }

  private async awaitPowerState(name: string, want: 'on' | 'off'): Promise<boolean> {
    for (let i = 0; i < 8; i++) {
      if ((await this.powerStates()).get(name) === want) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return (await this.powerStates()).get(name) === want;
  }

  async powerCycleRedfish(nodeName: string): Promise<number> {
    try {
      const { stdout } = await execFileP('bash', ['scripts/tasks/redfish.sh', nodeName, 'power-cycle'], {
        cwd: this.runner.repoRoot,
        timeout: 60_000,
      });
      if (stdout.trim()) {
        const lastLine = stdout.trim().split('\n').pop();
        if (lastLine) this.log.debug(lastLine);
      }
      return 0;
    } catch (e) {
      const err = e as { code?: number; stderr?: string };
      if (err.stderr?.trim()) {
        const lastLine = err.stderr.trim().split('\n').pop();
        if (lastLine) this.log.warn(lastLine);
      }
      return err.code ?? 1;
    }
  }
}
