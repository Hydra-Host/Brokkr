import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Envelope, parseEnvelope, safeParseEnvelope } from '../envelope.js';

const TS_2020 = 1_577_836_800_000;

const validByKind: Record<string, unknown> = {
  'agent.register': {
    type: 'agent.register',
    device_id: 'device-1',
    zone: { tenant_id: 't1' },
    agent_version: '1.2.3',
  },
  'agent.registered': {
    type: 'agent.registered',
    accepted: true,
    bridge_id: 'bridge-1',
    topology: [],
  },
  'work.request': {
    type: 'work.request',
    work_id: '123e4567-e89b-42d3-a456-426614174000',
    operation: 'collection.collectAll',
    input: {},
  },
  'work.response': {
    type: 'work.response',
    work_id: '123e4567-e89b-42d3-a456-426614174000',
    status: 'success',
  },
  'work.progress': {
    type: 'work.progress',
    work_id: '123e4567-e89b-42d3-a456-426614174000',
    progress: 0.5,
  },
  'collection.result': {
    type: 'collection.result',
    work_id: '123e4567-e89b-42d3-a456-426614174000',
    collector: 'architecture',
    status: 'success',
  },
  heartbeat: {
    type: 'heartbeat',
    ts: TS_2020,
  },
  'topology.update': {
    type: 'topology.update',
    bridges: [],
  },
};

describe('parseEnvelope', () => {
  it('parses a valid envelope and returns the typed object', () => {
    const env = parseEnvelope(JSON.stringify(validByKind['heartbeat']));
    expect(env.type).toBe('heartbeat');
  });

  it('accepts a Buffer (raw.toString() path)', () => {
    const env = parseEnvelope(Buffer.from(JSON.stringify(validByKind['topology.update'])));
    expect(env.type).toBe('topology.update');
  });

  it('throws SyntaxError on malformed JSON', () => {
    expect(() => parseEnvelope('{not json')).toThrow(SyntaxError);
  });

  it('throws ZodError on valid JSON with an unknown discriminator', () => {
    expect(() => parseEnvelope(JSON.stringify({ type: 'no.such.kind' }))).toThrow(z.ZodError);
  });

  it('throws ZodError on valid JSON missing a required field', () => {
    expect(() => parseEnvelope(JSON.stringify({ type: 'agent.register', agent_version: '1.0.0' }))).toThrow(z.ZodError);
  });
});

describe('safeParseEnvelope', () => {
  it('returns the success discriminant for a valid envelope', () => {
    const result = safeParseEnvelope(JSON.stringify(validByKind['agent.registered']));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('agent.registered');
    }
  });

  it('returns the invalid_json discriminant for non-JSON input', () => {
    const result = safeParseEnvelope('definitely not json');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe('invalid_json');
      expect(result.error).toBeInstanceOf(SyntaxError);
    }
  });

  it('returns the schema_violation discriminant for valid JSON that fails the schema', () => {
    const result = safeParseEnvelope(JSON.stringify({ type: 'heartbeat' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe('schema_violation');
      expect(result.error).toBeInstanceOf(z.ZodError);
    }
  });

  it('classifies an unknown discriminator as schema_violation, not invalid_json', () => {
    const result = safeParseEnvelope(JSON.stringify({ type: 'bogus' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe('schema_violation');
    }
  });

  it('never throws on garbage input', () => {
    expect(() => safeParseEnvelope('}{][')).not.toThrow();
  });
});

describe('Envelope discriminated union — per-variant acceptance', () => {
  it.each(Object.entries(validByKind))('accepts a valid %s envelope', (kind, payload) => {
    const result = Envelope.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe(kind);
    }
  });

  it('applies defaults: agent.register defaults protocol_version and readiness', () => {
    const parsed = Envelope.parse(validByKind['agent.register']);
    if (parsed.type === 'agent.register') {
      expect(parsed.protocol_version).toBe(1);
      expect(parsed.readiness).toBe('ready');
    }
  });

  it('accepts work.request with W3C trace context fields', () => {
    const parsed = Envelope.parse({
      type: 'work.request',
      work_id: '123e4567-e89b-42d3-a456-426614174000',
      operation: 'collection.collectAll',
      input: {},
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      tracestate: 'vendor=value',
    });
    if (parsed.type === 'work.request') {
      expect(parsed.traceparent).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
      expect(parsed.tracestate).toBe('vendor=value');
    }
  });
});

describe('Envelope discriminated union — rejection', () => {
  it('rejects an unknown discriminator value', () => {
    expect(Envelope.safeParse({ type: 'not.a.real.kind' }).success).toBe(false);
  });

  it('rejects a payload with no discriminator at all', () => {
    expect(Envelope.safeParse({ ts: TS_2020 }).success).toBe(false);
  });

  it('rejects agent.registered missing the required accepted field', () => {
    expect(Envelope.safeParse({ type: 'agent.registered', bridge_id: 'b1', topology: [] }).success).toBe(false);
  });

  it('rejects work.response with a wrong-type status field', () => {
    expect(
      Envelope.safeParse({
        type: 'work.response',
        work_id: '123e4567-e89b-42d3-a456-426614174000',
        status: 'maybe',
      }).success,
    ).toBe(false);
  });

  it('rejects heartbeat with a seconds-since-epoch ts (below the 2020 floor)', () => {
    expect(Envelope.safeParse({ type: 'heartbeat', ts: 1_577_836_800 }).success).toBe(false);
  });

  it('rejects work.progress with progress out of the [0,1] range', () => {
    expect(
      Envelope.safeParse({
        type: 'work.progress',
        work_id: '123e4567-e89b-42d3-a456-426614174000',
        progress: 1.5,
      }).success,
    ).toBe(false);
  });
});
