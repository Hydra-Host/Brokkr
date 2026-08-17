import { afterEach, describe, expect, it } from 'vitest';

import { buildDocsConfig, getDocsConfig, resetDocsConfigForTests } from '../docs.config';

afterEach(() => {
  resetDocsConfigForTests();
});

describe('buildDocsConfig — defaults', () => {
  it('exposes the canonical API metadata', () => {
    const cfg = buildDocsConfig({});
    expect(cfg.apiTitle).toBe('Brokkr Proxy API');
    expect(cfg.apiContactName).toBe('Brokkr API Support');
    expect(cfg.apiContactUrl).toBe('https://hydrahost.com');
    expect(cfg.apiServerDescription).toBe('Bridge Server');
    expect(cfg.swaggerUiVersion).toBe('5.18.2');
    expect(cfg.redocVersion).toBe('2.5.2');
    expect(cfg.enableSwaggerUi).toBe(true);
    expect(cfg.enableRedoc).toBe(true);
    expect(cfg.defaultDocsFormat).toBe('redoc');
  });

  it('resolves docsAssetsPath under the configured ASSETS_DIR', () => {
    const cfg = buildDocsConfig({ ASSETS_DIR: '/test/app/root/assets' });
    expect(cfg.docsAssetsPath).toBe('/test/app/root/assets/docs');
  });

  it('produces the swagger-ui config dict', () => {
    const cfg = buildDocsConfig({});
    expect(cfg.swaggerUiConfig.deepLinking).toBe(true);
    expect(cfg.swaggerUiConfig.docExpansion).toBe('list');
    expect(cfg.swaggerUiConfig.filter).toBe(true);
    expect(cfg.swaggerUiConfig.tryItOutEnabled).toBe(true);
  });

  it('produces the redoc options dict', () => {
    const cfg = buildDocsConfig({});
    expect(cfg.redocOptions.hideDownloadButton).toBe(false);
    expect(cfg.redocOptions.expandResponses).toBe('200,201');
    expect(cfg.redocOptions.sortTagsAlphabetically).toBe(true);
    expect(cfg.redocOptions.nativeScrollbars).toBe(true);
  });

  it('applies the Brokkr v2 redoc theme', () => {
    const cfg = buildDocsConfig({});
    const colors = cfg.redocTheme.colors as { primary: { main: string } };
    const sidebar = cfg.redocTheme.sidebar as { backgroundColor: string };
    const typography = cfg.redocTheme.typography as { fontFamily: string };
    const codeBlock = cfg.redocTheme.codeBlock as { backgroundColor: string };
    expect(colors.primary.main).toBe('#ffdc75');
    expect(sidebar.backgroundColor).toBe('#221a17');
    expect(typography.fontFamily).toBe('JetBrains Mono, monospace');
    expect(codeBlock.backgroundColor).toBe('#0d0805');
  });

  it('embeds the API contact info in openapiInfo', () => {
    const cfg = buildDocsConfig({});
    expect(cfg.openapiInfo).toHaveProperty('description');
    expect(cfg.openapiInfo).toHaveProperty('contact');
    const contact = cfg.openapiInfo.contact as { name: string };
    expect(contact.name).toBe('Brokkr API Support');
  });

  it('emits empty securitySchemes (no mTLS examples)', () => {
    const cfg = buildDocsConfig({});
    expect(cfg.securitySchemes).toEqual({});
  });
});

describe('getDocsConfig', () => {
  it('returns the cached instance on subsequent calls', () => {
    const a = getDocsConfig();
    const b = getDocsConfig();
    expect(a).toBe(b);
  });
});
