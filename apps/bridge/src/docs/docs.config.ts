import { existsSync } from 'node:fs';
import { join } from 'node:path';

import * as nunjucks from 'nunjucks';

import { resolveAssetsDir } from '../core/application.config.js';

export interface DocsConfig {
  apiTitle: string;
  apiContactName: string;
  apiContactUrl: string;
  apiServerDescription: string;
  docsAssetsPath: string;
  swaggerUiVersion: string;
  redocVersion: string;
  enableSwaggerUi: boolean;
  enableRedoc: boolean;
  defaultDocsFormat: string;
  swaggerUiConfig: Record<string, unknown>;
  redocOptions: Record<string, unknown>;
  redocTheme: Record<string, unknown>;
  openapiInfo: Record<string, unknown>;
  securitySchemes: Record<string, unknown>;
}

function buildOpenapiInfo(
  apiTitle: string,
  apiContactName: string,
  apiContactUrl: string,
  docsAssetsPath: string,
): Record<string, unknown> {
  const description = loadApiDescription(docsAssetsPath, apiTitle);
  return {
    description,
    contact: { name: apiContactName, url: apiContactUrl },
  };
}

function loadApiDescription(docsAssetsPath: string, apiTitle: string): string {
  const filename = 'api-description.md';
  try {
    const templatePath = join(docsAssetsPath, filename);
    if (!existsSync(templatePath)) {
      return `Template file ${filename} not found`;
    }
    const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(docsAssetsPath), { autoescape: false });
    return env.render(filename, { api_title: apiTitle });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return `Error loading template ${filename}: ${message}`;
  }
}

const SWAGGER_UI_CONFIG: Record<string, unknown> = {
  deepLinking: true,
  docExpansion: 'list',
  filter: true,
  showExtensions: true,
  showCommonExtensions: true,
  defaultModelsExpandDepth: 1,
  defaultModelExpandDepth: 1,
  tryItOutEnabled: true,
  supportedSubmitMethods: ['get', 'post', 'put', 'delete', 'patch'],
};

const REDOC_OPTIONS: Record<string, unknown> = {
  hideDownloadButton: false,
  expandResponses: '200,201',
  sortTagsAlphabetically: true,
  sortOperationsAlphabetically: true,
  nativeScrollbars: true,
};

const REDOC_THEME: Record<string, unknown> = {
  colors: {
    primary: { main: '#ffdc75' },
    success: { main: '#6fec4f' },
    error: { main: '#ff383b' },
    warning: { main: '#fbd424' },
    text: { primary: '#fff3ce', secondary: '#ad9985' },
    http: {
      get: '#60a5fa',
      post: '#6fec4f',
      put: '#fbd424',
      patch: '#ffdc75',
      delete: '#ff383b',
      options: '#ad9985',
      head: '#ad9985',
    },
  },
  schema: {
    nestedBackground: '#19120f',
    typeNameColor: '#ffdc75',
    typeTitleColor: '#fff3ce',
    requireLabelColor: '#ff383b',
    labelsTextSize: '0.8em',
    nestingSpacing: '1em',
    arrow: { size: '1em', color: '#ad9985' },
  },
  sidebar: {
    backgroundColor: '#221a17',
    textColor: '#ad9985',
    activeTextColor: '#ffdc75',
    groupItems: { activeBackgroundColor: '#100b09', activeTextColor: '#ffdc75' },
    level1Items: { activeBackgroundColor: '#100b09', activeTextColor: '#ffdc75' },
    arrow: { size: '1em', color: '#60514b' },
  },
  typography: {
    fontSize: '14px',
    lineHeight: '1.6em',
    fontFamily: 'JetBrains Mono, monospace',
    headings: { fontFamily: 'JetBrains Mono, monospace', fontWeight: '600', color: '#fff3ce' },
    code: {
      fontSize: '13px',
      fontFamily: 'JetBrains Mono, monospace',
      color: '#fff3ce',
      backgroundColor: '#0d0805',
      wrap: true,
    },
    links: { color: '#ffdc75', hover: '#978243' },
  },
  rightPanel: {
    backgroundColor: '#19120f',
    textColor: '#fff3ce',
    servers: { overlay: { backgroundColor: '#100b09', textColor: '#fff3ce' } },
  },
  codeBlock: { backgroundColor: '#0d0805' },
};

let cached: DocsConfig | undefined;

export function buildDocsConfig(env: NodeJS.ProcessEnv = process.env): DocsConfig {
  const apiTitle = 'Brokkr Proxy API';
  const apiContactName = 'Brokkr API Support';
  const apiContactUrl = 'https://hydrahost.com';
  const docsAssetsPath = join(resolveAssetsDir(env), 'docs');
  return {
    apiTitle,
    apiContactName,
    apiContactUrl,
    apiServerDescription: 'Bridge Server',
    docsAssetsPath,
    swaggerUiVersion: '5.18.2',
    redocVersion: '2.5.2',
    enableSwaggerUi: true,
    enableRedoc: true,
    defaultDocsFormat: 'redoc',
    swaggerUiConfig: SWAGGER_UI_CONFIG,
    redocOptions: REDOC_OPTIONS,
    redocTheme: REDOC_THEME,
    openapiInfo: buildOpenapiInfo(apiTitle, apiContactName, apiContactUrl, docsAssetsPath),
    securitySchemes: {},
  };
}

export function getDocsConfig(): DocsConfig {
  if (cached === undefined) {
    cached = buildDocsConfig();
  }
  return cached;
}

export function resetDocsConfigForTests(): void {
  cached = undefined;
}
