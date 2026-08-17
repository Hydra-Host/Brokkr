import { createPublicKey, generateKeyPairSync } from 'node:crypto';

import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { canonicalizeAad, seal as cryptoSeal } from '@repo/crypto';

import { ContextLogger } from '../../logger/logger.service.js';
import { ZoneCryptoService, type ZoneCryptoSnapshot } from '../../zone-crypto/zone-crypto.service.js';
import { BullmqModule } from '../bullmq.module.js';
import type { ProcessableJob } from '../handlers.service.js';
import { InboundEnvelopeOpenerService } from '../inbound-envelope.service.js';
import { SagaCooldownClearerService } from '../saga-cooldown-clearer.service.js';
import { CURRENT_ENVELOPE_VERSION, DIRECTION_HUB_TO_BRIDGE } from '../sealed-envelope.js';

const ZONE_ID = '00000000-0000-4000-8000-000000000001';
const LIFECYCLE_QUEUE = 'lifecycle';
const KEY_SIZE = 32;

interface Keypair {
  priv: Buffer;
  pub: Buffer;
}

function genKeypair(): Keypair {
  const kp = generateKeyPairSync('x25519');
  const pkcs8 = kp.privateKey.export({ format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(kp.privateKey).export({ format: 'der', type: 'spki' });
  return {
    priv: Buffer.from(pkcs8.subarray(pkcs8.length - KEY_SIZE)),
    pub: Buffer.from(spki.subarray(spki.length - KEY_SIZE)),
  };
}

function buildHubToBridgeEnvelope(hub: Keypair, zone: Keypair, plaintext: Buffer): Record<string, unknown> {
  const aad: Record<string, unknown> = {
    aad_v: 1,
    zone_id: ZONE_ID,
    queue_name: LIFECYCLE_QUEUE,
    direction: DIRECTION_HUB_TO_BRIDGE,
    job_id: 'plan-1',
    created_at: Date.now(),
  };
  const aadBytes = canonicalizeAad(aad);
  const sealed = cryptoSeal(hub.priv, zone.pub, plaintext, aadBytes);
  return {
    envelope_v: CURRENT_ENVELOPE_VERSION,
    aad,
    eph_pub: sealed.ephPub.toString('base64'),
    ciphertext: sealed.ciphertext.toString('base64'),
    tag: sealed.tag.toString('base64'),
  };
}

const STUB_TOKENS = {
  sagaCache: Symbol('test:sagaCache'),
  sagaPlanManager: Symbol('test:sagaPlanManager'),
  sagaRunner: Symbol('test:sagaRunner'),
  collDispatcher: Symbol('test:collDispatcher'),
  collRegistry: Symbol('test:collRegistry'),
  collResults: Symbol('test:collResults'),
  collCache: Symbol('test:collCache'),
  diagDispatcher: Symbol('test:diagDispatcher'),
  diagRegistry: Symbol('test:diagRegistry'),
  testDispatcher: Symbol('test:testDispatcher'),
  testRegistry: Symbol('test:testRegistry'),
  cooldownCache: Symbol('test:cooldownCache'),
};

@Global()
@Module({
  providers: [
    ...Object.values(STUB_TOKENS).map((token) => ({
      provide: token,
      useValue: {} as never,
    })),
    { provide: ContextLogger, useValue: new ContextLogger() },
  ],
  exports: [...Object.values(STUB_TOKENS), ContextLogger],
})
class StubHandlerDepsModule {}

async function compileWithStubs(): Promise<
  Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>
> {
  return Test.createTestingModule({
    imports: [
      StubHandlerDepsModule,
      BullmqModule.forRoot({
        sagaHandlerCacheToken: STUB_TOKENS.sagaCache,
        sagaHandlerPlanManagerToken: STUB_TOKENS.sagaPlanManager,
        sagaHandlerRunnerToken: STUB_TOKENS.sagaRunner,
        sagaHandlerSagaProvider: {} as never,
        sagaHandlerConfig: {} as never,
        collectionHandlerDispatcherToken: STUB_TOKENS.collDispatcher,
        collectionHandlerRegistryToken: STUB_TOKENS.collRegistry,
        collectionHandlerResultsToken: STUB_TOKENS.collResults,
        collectionHandlerCacheToken: STUB_TOKENS.collCache,
        collectionHandlerCooldown: {} as never,
        diagnosticsHandlerDispatcherToken: STUB_TOKENS.diagDispatcher,
        diagnosticsHandlerRegistryToken: STUB_TOKENS.diagRegistry,
        testingHandlerDispatcherToken: STUB_TOKENS.testDispatcher,
        testingHandlerRegistryToken: STUB_TOKENS.testRegistry,
        sagaCooldownClearerCacheToken: STUB_TOKENS.cooldownCache,
        inboundEnvelopeOpenerZoneIdProvider: { getZoneId: () => ZONE_ID },
      }),
    ],
  })
    .overrideProvider(SagaCooldownClearerService)
    .useValue({})
    .compile();
}

describe('BullmqModule.forRoot wiring', () => {
  it('resolves InboundEnvelopeOpenerService from the container', async () => {
    const moduleRef = await compileWithStubs();
    const opener = moduleRef.get(InboundEnvelopeOpenerService);
    expect(opener).toBeInstanceOf(InboundEnvelopeOpenerService);
  });

  it('decrypts a hub→bridge sealed envelope end-to-end via DI', async () => {
    const hub = genKeypair();
    const zone = genKeypair();

    const moduleRef = await compileWithStubs();

    const zoneCrypto = moduleRef.get(ZoneCryptoService);
    const snapshot: ZoneCryptoSnapshot = {
      zonePriv: zone.priv,
      zonePub: zone.pub,
      hubPub: hub.pub,
      enrolledAt: 1_730_000_000_000,
    };
    zoneCrypto.set(snapshot);

    const inner = {
      plan_id: 'plan-sealed',
      saga_name: 'deprovision',
      payload: { device_id: 'dev-1' },
    };
    const plaintext = Buffer.from(JSON.stringify(inner), 'utf-8');
    const envelope = buildHubToBridgeEnvelope(hub, zone, plaintext);
    const job: ProcessableJob<unknown> = {
      id: 'job-1',
      name: 'saga.run',
      data: envelope,
      queue: { name: LIFECYCLE_QUEUE },
      scripts: {
        moveToDelayed: async () => {},
      },
    };

    const opener = moduleRef.get(InboundEnvelopeOpenerService);
    const opened = await opener.open(job);
    expect(opened.payload).toEqual(inner);
    expect(opened.createdAtMs).toBeTypeOf('number');
    expect(opened.isBridgeLocal).toBe(false);
  });
});
