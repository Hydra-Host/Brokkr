import { Injectable } from '@nestjs/common';
import { CableTerminationType } from '@repo/database';
import { ContextService } from 'src/common/context/context.service';
import { PrismaClient } from 'src/prisma/prisma.client';

@Injectable()
export class ConnectionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly contextService: ContextService,
  ) {}

  private get supplierId(): string {
    return this.contextService.organizationId;
  }

  async listInterfaceConnections(query: { deviceId?: string; zoneId?: string }) {
    const supplierId = this.supplierId;

    const targetIfaces = await this.prisma.interface.findMany({
      where: {
        device: {
          supplierId,
          ...(query.zoneId ? { zoneId: query.zoneId } : {}),
        },
        ...(query.deviceId ? { deviceId: query.deviceId } : {}),
      },
      select: { id: true },
    });
    if (targetIfaces.length === 0) return [];

    const targetIds = targetIfaces.map((i) => i.id);

    const cables = await this.prisma.cable.findMany({
      where: {
        terminations: {
          some: { terminationType: CableTerminationType.INTERFACE, terminationId: { in: targetIds } },
        },
      },
      include: { terminations: { orderBy: { cableSide: 'asc' } } },
    });
    if (cables.length === 0) return [];

    const involvedIds = new Set<string>();
    for (const cable of cables) {
      for (const t of cable.terminations) {
        if (t.terminationType === CableTerminationType.INTERFACE) involvedIds.add(t.terminationId);
      }
    }

    const ownedIfaces = await this.prisma.interface.findMany({
      where: { id: { in: Array.from(involvedIds) }, device: { supplierId } },
      select: { id: true, name: true, deviceId: true },
    });
    const byId = new Map(ownedIfaces.map((i) => [i.id, i]));

    const connections: Array<{
      interfaceA: { id: string; name: string; deviceId: string };
      interfaceB: { id: string; name: string; deviceId: string };
      cableId: string;
    }> = [];

    for (const cable of cables) {
      const a = cable.terminations.find((t) => t.cableSide === 'A');
      const b = cable.terminations.find((t) => t.cableSide === 'B');
      if (!a || !b) continue;
      if (a.terminationType !== CableTerminationType.INTERFACE || b.terminationType !== CableTerminationType.INTERFACE)
        continue;
      const ifaceA = byId.get(a.terminationId);
      const ifaceB = byId.get(b.terminationId);
      if (!ifaceA || !ifaceB) continue;
      connections.push({
        interfaceA: { id: ifaceA.id, name: ifaceA.name, deviceId: ifaceA.deviceId },
        interfaceB: { id: ifaceB.id, name: ifaceB.name, deviceId: ifaceB.deviceId },
        cableId: cable.id,
      });
    }
    return connections;
  }

  async listConsoleConnections(query: { deviceId?: string; zoneId?: string }) {
    const supplierId = this.supplierId;

    const deviceWhere = {
      supplierId,
      ...(query.zoneId ? { zoneId: query.zoneId } : {}),
    };
    const portWhere = {
      device: deviceWhere,
      ...(query.deviceId ? { deviceId: query.deviceId } : {}),
    };

    const [targetCp, targetCsp] = await Promise.all([
      this.prisma.consolePort.findMany({ where: portWhere, select: { id: true } }),
      this.prisma.consoleServerPort.findMany({ where: portWhere, select: { id: true } }),
    ]);
    if (targetCp.length === 0 && targetCsp.length === 0) return [];

    const targetCpIds = targetCp.map((c) => c.id);
    const targetCspIds = targetCsp.map((c) => c.id);

    const cables = await this.prisma.cable.findMany({
      where: {
        terminations: {
          some: {
            OR: [
              { terminationType: CableTerminationType.CONSOLE_PORT, terminationId: { in: targetCpIds } },
              { terminationType: CableTerminationType.CONSOLE_SERVER_PORT, terminationId: { in: targetCspIds } },
            ],
          },
        },
      },
      include: { terminations: { orderBy: { cableSide: 'asc' } } },
    });
    if (cables.length === 0) return [];

    const involvedCpIds = new Set<string>();
    const involvedCspIds = new Set<string>();
    for (const cable of cables) {
      for (const t of cable.terminations) {
        if (t.terminationType === CableTerminationType.CONSOLE_PORT) involvedCpIds.add(t.terminationId);
        else if (t.terminationType === CableTerminationType.CONSOLE_SERVER_PORT) involvedCspIds.add(t.terminationId);
      }
    }

    const [ownedCp, ownedCsp] = await Promise.all([
      this.prisma.consolePort.findMany({
        where: { id: { in: Array.from(involvedCpIds) }, device: { supplierId } },
        select: { id: true, name: true, deviceId: true },
      }),
      this.prisma.consoleServerPort.findMany({
        where: { id: { in: Array.from(involvedCspIds) }, device: { supplierId } },
        select: { id: true, name: true, deviceId: true },
      }),
    ]);
    const cpById = new Map(ownedCp.map((c) => [c.id, c]));
    const cspById = new Map(ownedCsp.map((c) => [c.id, c]));

    const connections: Array<{
      consolePort: { id: string; name: string; deviceId: string };
      consoleServerPort: { id: string; name: string; deviceId: string };
      cableId: string;
    }> = [];

    for (const cable of cables) {
      const cpTerm = cable.terminations.find((t) => t.terminationType === CableTerminationType.CONSOLE_PORT);
      const cspTerm = cable.terminations.find((t) => t.terminationType === CableTerminationType.CONSOLE_SERVER_PORT);
      if (!cpTerm || !cspTerm) continue;
      const cp = cpById.get(cpTerm.terminationId);
      const csp = cspById.get(cspTerm.terminationId);
      if (!cp || !csp) continue;
      connections.push({
        consolePort: { id: cp.id, name: cp.name, deviceId: cp.deviceId },
        consoleServerPort: { id: csp.id, name: csp.name, deviceId: csp.deviceId },
        cableId: cable.id,
      });
    }
    return connections;
  }

  async listPowerConnections(query: { deviceId?: string; zoneId?: string }) {
    const supplierId = this.supplierId;

    const deviceWhere = {
      supplierId,
      ...(query.zoneId ? { zoneId: query.zoneId } : {}),
    };
    const portWhere = {
      device: deviceWhere,
      ...(query.deviceId ? { deviceId: query.deviceId } : {}),
    };

    const [targetPp, targetPo] = await Promise.all([
      this.prisma.powerPort.findMany({ where: portWhere, select: { id: true } }),
      this.prisma.powerOutlet.findMany({ where: portWhere, select: { id: true } }),
    ]);
    if (targetPp.length === 0 && targetPo.length === 0) return [];

    const targetPpIds = targetPp.map((p) => p.id);
    const targetPoIds = targetPo.map((p) => p.id);

    const cables = await this.prisma.cable.findMany({
      where: {
        terminations: {
          some: {
            OR: [
              { terminationType: CableTerminationType.POWER_PORT, terminationId: { in: targetPpIds } },
              { terminationType: CableTerminationType.POWER_OUTLET, terminationId: { in: targetPoIds } },
            ],
          },
        },
      },
      include: { terminations: { orderBy: { cableSide: 'asc' } } },
    });
    if (cables.length === 0) return [];

    const involvedPpIds = new Set<string>();
    const involvedPoIds = new Set<string>();
    for (const cable of cables) {
      for (const t of cable.terminations) {
        if (t.terminationType === CableTerminationType.POWER_PORT) involvedPpIds.add(t.terminationId);
        else if (t.terminationType === CableTerminationType.POWER_OUTLET) involvedPoIds.add(t.terminationId);
      }
    }

    const [ownedPp, ownedPo] = await Promise.all([
      this.prisma.powerPort.findMany({
        where: { id: { in: Array.from(involvedPpIds) }, device: { supplierId } },
        select: { id: true, name: true, deviceId: true },
      }),
      this.prisma.powerOutlet.findMany({
        where: { id: { in: Array.from(involvedPoIds) }, device: { supplierId } },
        select: { id: true, name: true, deviceId: true },
      }),
    ]);
    const ppById = new Map(ownedPp.map((p) => [p.id, p]));
    const poById = new Map(ownedPo.map((p) => [p.id, p]));

    const connections: Array<{
      powerPort: { id: string; name: string; deviceId: string };
      powerOutlet: { id: string; name: string; deviceId: string };
      cableId: string;
    }> = [];

    for (const cable of cables) {
      const ppTerm = cable.terminations.find((t) => t.terminationType === CableTerminationType.POWER_PORT);
      const poTerm = cable.terminations.find((t) => t.terminationType === CableTerminationType.POWER_OUTLET);
      if (!ppTerm || !poTerm) continue;
      const pp = ppById.get(ppTerm.terminationId);
      const po = poById.get(poTerm.terminationId);
      if (!pp || !po) continue;
      connections.push({
        powerPort: { id: pp.id, name: pp.name, deviceId: pp.deviceId },
        powerOutlet: { id: po.id, name: po.name, deviceId: po.deviceId },
        cableId: cable.id,
      });
    }
    return connections;
  }
}
