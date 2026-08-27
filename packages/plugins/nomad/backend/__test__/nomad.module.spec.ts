import 'reflect-metadata';

import { PLUGIN_REQUEST_CONTEXT } from '@hydrahost/plugin-sdk';
import { PluginOperatorGuard } from '@hydrahost/plugin-sdk/nest';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import type { NomadConfig } from '../../schemas';
import { NOMAD_CONFIG_TOKEN } from '../config.token';
import { NomadClient } from '../nomad.client';
import { NomadController } from '../nomad.controller';
import { NomadJobsService } from '../nomad-jobs.service';
import { NomadModule } from '../nomad.module';

const testConfig: NomadConfig = {
  address: 'http://127.0.0.1:4646',
  token: 'test-token',
  namespace: 'default',
  timeoutMs: 5_000,
  tlsSkipVerify: false,
  adminOrganizationId: '',
};

@Global()
@Module({
  providers: [
    { provide: NOMAD_CONFIG_TOKEN, useValue: testConfig },
    {
      provide: PLUGIN_REQUEST_CONTEXT,
      useValue: { requireOperator: () => undefined },
    },
  ],
  exports: [NOMAD_CONFIG_TOKEN, PLUGIN_REQUEST_CONTEXT],
})
class NomadConfigTestModule {}

describe('NomadModule', () => {
  it('compiles and provides NomadClient + NomadJobsService from plugin config', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NomadConfigTestModule, NomadModule],
    }).compile();

    expect(moduleRef.get(NomadClient)).toBeInstanceOf(NomadClient);
    expect(moduleRef.get(NomadJobsService)).toBeInstanceOf(NomadJobsService);
    expect(moduleRef.get(NOMAD_CONFIG_TOKEN)).toEqual(testConfig);
  });

  it('applies the shared PluginOperatorGuard at the controller class level', () => {
    const guards = Reflect.getMetadata('__guards__', NomadController) as unknown[] | undefined;
    expect(guards).toEqual([PluginOperatorGuard]);
  });
});
