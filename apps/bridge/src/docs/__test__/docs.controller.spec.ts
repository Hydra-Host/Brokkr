import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DocsController } from '../docs.controller.js';

interface RecordedReply {
  status: number | null;
  headers: Record<string, string>;
  body: unknown;
  redirected: string | null;
}

function recordingReply(): { reply: any; recorded: RecordedReply } {
  const recorded: RecordedReply = { status: null, headers: {}, body: null, redirected: null };
  const reply: any = {
    status(code: number) {
      recorded.status = code;
      return reply;
    },
    header(name: string, value: string) {
      recorded.headers[name.toLowerCase()] = value;
      return reply;
    },
    async send(payload: unknown) {
      recorded.body = payload;
      return reply;
    },
    async redirect(location: string) {
      recorded.status = recorded.status ?? 302;
      recorded.headers['location'] = location;
      recorded.redirected = location;
      return reply;
    },
  };
  return { reply, recorded };
}

function makeLogger(): any {
  return {
    debug: vi.fn(async () => {}),
    info: vi.fn(async () => {}),
    warning: vi.fn(async () => {}),
    error: vi.fn(async () => {}),
  };
}

function makeDocsService(overrides: Record<string, unknown> = {}): any {
  return {
    getSpecDict: vi.fn(() => ({})),
    getDefaultDocsFormat: vi.fn(() => 'swagger'),
    isSwaggerEnabled: vi.fn(() => true),
    isRedocEnabled: vi.fn(() => true),
    renderSwaggerUi: vi.fn(async () => '<html>Swagger UI</html>'),
    renderRedoc: vi.fn(async () => '<html>ReDoc</html>'),
    ...overrides,
  };
}

describe('routes/docs — apispec.json', () => {
  it('returns 200 with the generated OpenAPI specification', async () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Bridge API', version: '1.0.0', description: 'Bridge infrastructure API' },
      paths: {
        '/api/status': {
          get: { summary: 'Get bridge status', responses: { 200: { description: 'Success' } } },
        },
      },
    };
    const service = makeDocsService({ getSpecDict: vi.fn(() => spec) });
    const controller = new DocsController(service, makeLogger());
    const { reply, recorded } = recordingReply();

    await controller.getApispec(reply);

    expect(recorded.status).toBe(200);
    const body = recorded.body as Record<string, unknown>;
    expect(body['openapi']).toBe('3.0.0');
    expect(body).toHaveProperty('paths');
    expect((body['paths'] as Record<string, unknown>)['/api/status']).toBeDefined();
  });

  it('returns 500 when the DocsService raises while generating the spec', async () => {
    const service = makeDocsService({
      getSpecDict: vi.fn(() => {
        throw new Error('Spec generation failed');
      }),
    });
    const controller = new DocsController(service, makeLogger());
    const { reply, recorded } = recordingReply();

    await controller.getApispec(reply);

    expect(recorded.status).toBe(500);
    expect((recorded.body as Record<string, unknown>)['error']).toBeDefined();
  });

  it('returns 200 with {} when the spec is empty', async () => {
    const service = makeDocsService({ getSpecDict: vi.fn(() => ({})) });
    const controller = new DocsController(service, makeLogger());
    const { reply, recorded } = recordingReply();

    await controller.getApispec(reply);

    expect(recorded.status).toBe(200);
    expect(recorded.body).toEqual({});
  });
});

describe('routes/docs — /docs redirect', () => {
  it('redirects to /docs/swagger when swagger is the default + enabled', async () => {
    const service = makeDocsService({
      getDefaultDocsFormat: vi.fn(() => 'swagger'),
      isSwaggerEnabled: vi.fn(() => true),
      isRedocEnabled: vi.fn(() => true),
    });
    const controller = new DocsController(service, makeLogger());
    const { reply, recorded } = recordingReply();

    await controller.docsRedirect(reply);

    expect(recorded.status).toBe(302);
    expect(recorded.headers['location']).toBe('/docs/swagger');
  });

  it('redirects to /docs/redoc when redoc is the default + enabled', async () => {
    const service = makeDocsService({
      getDefaultDocsFormat: vi.fn(() => 'redoc'),
      isSwaggerEnabled: vi.fn(() => true),
      isRedocEnabled: vi.fn(() => true),
    });
    const controller = new DocsController(service, makeLogger());
    const { reply, recorded } = recordingReply();

    await controller.docsRedirect(reply);

    expect(recorded.status).toBe(302);
    expect(recorded.headers['location']).toBe('/docs/redoc');
  });

  it('falls back to /docs/redoc when the default UI is disabled but redoc is enabled', async () => {
    const service = makeDocsService({
      getDefaultDocsFormat: vi.fn(() => 'swagger'),
      isSwaggerEnabled: vi.fn(() => false),
      isRedocEnabled: vi.fn(() => true),
    });
    const controller = new DocsController(service, makeLogger());
    const { reply, recorded } = recordingReply();

    await controller.docsRedirect(reply);

    expect(recorded.status).toBe(302);
    expect(recorded.headers['location']).toBe('/docs/redoc');
  });

  it('returns 404 when neither swagger nor redoc is enabled', async () => {
    const service = makeDocsService({
      getDefaultDocsFormat: vi.fn(() => 'swagger'),
      isSwaggerEnabled: vi.fn(() => false),
      isRedocEnabled: vi.fn(() => false),
    });
    const controller = new DocsController(service, makeLogger());
    const { reply, recorded } = recordingReply();

    await controller.docsRedirect(reply);

    expect(recorded.status).toBe(404);
  });
});

describe('routes/docs — /docs/swagger', () => {
  it('renders the Swagger UI HTML with text/html content-type when enabled', async () => {
    const service = makeDocsService({
      isSwaggerEnabled: vi.fn(() => true),
      renderSwaggerUi: vi.fn(async () => '<html>Swagger UI</html>'),
    });
    const controller = new DocsController(service, makeLogger());
    const { reply, recorded } = recordingReply();

    await controller.swaggerUi(reply);

    expect(recorded.status).toBe(200);
    expect(recorded.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(String(recorded.body)).toContain('Swagger UI');
  });

  it('returns 404 when swagger is disabled', async () => {
    const service = makeDocsService({ isSwaggerEnabled: vi.fn(() => false) });
    const controller = new DocsController(service, makeLogger());
    const { reply, recorded } = recordingReply();

    await controller.swaggerUi(reply);

    expect(recorded.status).toBe(404);
  });
});

describe('routes/docs — /docs/redoc', () => {
  it('renders the ReDoc HTML with text/html content-type when enabled', async () => {
    const service = makeDocsService({
      isRedocEnabled: vi.fn(() => true),
      renderRedoc: vi.fn(async () => '<html>ReDoc</html>'),
    });
    const controller = new DocsController(service, makeLogger());
    const { reply, recorded } = recordingReply();

    await controller.redoc(reply);

    expect(recorded.status).toBe(200);
    expect(recorded.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(String(recorded.body)).toContain('ReDoc');
  });

  it('returns 404 when redoc is disabled', async () => {
    const service = makeDocsService({ isRedocEnabled: vi.fn(() => false) });
    const controller = new DocsController(service, makeLogger());
    const { reply, recorded } = recordingReply();

    await controller.redoc(reply);

    expect(recorded.status).toBe(404);
  });
});

describe('routes/docs — test-isolation sentinel', () => {
  beforeEach(() => {});
  it('confirms stub recorders are fresh per test', () => {
    const a = recordingReply();
    const b = recordingReply();
    expect(a.recorded).not.toBe(b.recorded);
  });
});
