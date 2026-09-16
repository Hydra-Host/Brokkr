import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { LAB_ROUTE, type LabRouteOptions } from '../../common/lab-route';
import type { ProcessComposeClient } from '../../services/process-compose.client';
import { InitTasksService } from '../init-tasks.service';
import { StackController } from '../stack.controller';

const reflector = new Reflector();

describe('StackController capability annotations', () => {
  it('prices startStackRun at admin — every stack op spawns a host command', () => {
    expect(reflector.get<LabRouteOptions | undefined>(LAB_ROUTE, StackController.prototype.startRun)).toEqual({
      capability: 'admin',
    });
  });

  it('prices controlDatastore at admin alongside it', () => {
    expect(reflector.get<LabRouteOptions | undefined>(LAB_ROUTE, StackController.prototype.controlDatastore)).toEqual({
      capability: 'admin',
    });
  });

  it('leaves restartState at read — a GET that mutates nothing', () => {
    expect(
      reflector.get<LabRouteOptions | undefined>(LAB_ROUTE, StackController.prototype.restartState),
    ).toBeUndefined();
  });

  it('leaves the init-task listing at read but prices its log stream like the op it reports on', () => {
    expect(
      reflector.get<LabRouteOptions | undefined>(LAB_ROUTE, StackController.prototype.initTasksList),
    ).toBeUndefined();
    expect(reflector.get<LabRouteOptions | undefined>(LAB_ROUTE, StackController.prototype.initTaskLog)).toEqual({
      capability: 'admin',
    });
  });
});

describe('StackController init-task log allowlist', () => {
  const controllerWith = (roster: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-init-exposure-'));
    for (const name of roster) writeFileSync(join(dir, `${name}.log`), 'x\n');
    const pc = {
      taskLogDir: () => dir,
      socketMtimeMs: () => 0,
      tailFileLast: () => undefined,
      streamTaskLog: vi.fn(() => of('line\n')),
    };
    const initTasks = new InitTasksService(pc as unknown as ProcessComposeClient);
    return { controller: new StackController({} as never, {} as never, initTasks, {} as never), pc };
  };

  it('rejects a traversal name instead of joining it onto the log dir', () => {
    const { controller, pc } = controllerWith(['hub:init']);

    expect(() => controller.initTaskLog('../../../etc/passwd')).toThrow(NotFoundException);
    expect(pc.streamTaskLog).not.toHaveBeenCalled();
  });

  it('streams a name that is in the derived roster', () => {
    const { controller, pc } = controllerWith(['hub:init']);

    controller.initTaskLog('hub:init');

    expect(pc.streamTaskLog).toHaveBeenCalledWith('hub:init');
  });
});
