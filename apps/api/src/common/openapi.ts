import { OS_SLUG_DESCRIPTION_PREFIX, type RouteMetadata, type RouteVisibility } from '@repo/api-client';
import { isRecord } from '@repo/utils';
import { generateOpenApi } from '@ts-rest/open-api';
import { BRAND_NAME } from 'src/common/branding';
import { getPluginIdForPath, mergedContract } from 'src/plugin-host/merged-contract';
import type { PrismaClient } from 'src/prisma/prisma.client';

const API_DESCRIPTION = `# Welcome to the ${BRAND_NAME} Platform API

The ${BRAND_NAME} API provides powerful, programmatic access to manage your infrastructure and deployments through a RESTful interface.

## Rate Limits

The API is rate limited to 100 requests per minute. If you exceed this limit, requests will return a 429 status code. Contact your ${BRAND_NAME} operator if you need a higher limit.

## Authentication

All API requests must be authenticated using an API key. Here's how to get started:

### Getting Your API Key

1. Sign in to your ${BRAND_NAME} account in the web app
2. Click on your organization name in the sidebar
3. Select the **API Keys** tab
   > Note: If you don't see the API Keys tab, contact your ${BRAND_NAME} operator for access
4. Click the **Create Key** button
5. Copy and securely store your API key

### Using Your API Key

To authenticate requests, include your API key in the request headers:

\`\`\`http
x-api-key: YOUR_API_KEY
\`\`\`
`;

const TAG_OVERRIDES: Record<string, string> = {
  sshkeys: 'SSH Keys',
  me: 'Authentication',
};

function deriveTagFromPath(path: string): string {
  const pluginId = getPluginIdForPath(path);
  if (pluginId) {
    return `Plugin: ${titleize(pluginId)}`;
  }
  const withoutPrefix = path.replace(/^\/api\/v\d+\/?/, '');
  const firstSegment = withoutPrefix.split('/')[0] || 'General';
  if (TAG_OVERRIDES[firstSegment]) {
    return TAG_OVERRIDES[firstSegment];
  }
  return titleize(firstSegment);
}

function titleize(segment: string): string {
  return segment
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const OS_SLUG_DESCRIPTION_MARKER = OS_SLUG_DESCRIPTION_PREFIX;

export async function generateApiDocument(
  prisma: PrismaClient | null,
  visibilityFilter: RouteVisibility[] = ['public'],
) {
  const doc = generateOpenApi(
    mergedContract,
    {
      info: {
        title: `${BRAND_NAME} API`,
        description: API_DESCRIPTION,
        version: '1.0.0',
      },
      servers: [
        {
          url: '/',
          description: 'API Server',
        },
      ],
      components: {
        securitySchemes: {
          ApiKey: {
            type: 'apiKey',
            name: 'x-api-key',
            in: 'header',
          },
        },
      },
    },
    {
      setOperationId: true,
      operationMapper: (operation, appRoute) => {
        const meta = appRoute.metadata as RouteMetadata | undefined;
        // Fail closed: missing visibility metadata is treated as 'internal' so a forgotten tag never leaks an endpoint into the public doc.
        const routeVisibility = meta?.visibility ?? 'internal';
        if (!visibilityFilter.includes(routeVisibility)) {
          return { ...operation, 'x-internal': true };
        }
        return {
          ...operation,
          tags: [deriveTagFromPath(appRoute.path)],
        };
      },
    },
  );

  const usedTags = new Set<string>();
  if (doc.paths) {
    for (const [pathKey, pathItem] of Object.entries(doc.paths)) {
      if (!pathItem) continue;
      for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
        const op = pathItem[method] as Record<string, unknown> | undefined;
        if (op?.['x-internal']) {
          delete pathItem[method];
        } else if (op?.tags) {
          for (const tag of op.tags as string[]) {
            usedTags.add(tag);
          }
        }
      }
      const remaining = ['get', 'post', 'put', 'patch', 'delete'].filter((m) => pathItem[m as keyof typeof pathItem]);
      if (remaining.length === 0) {
        delete doc.paths[pathKey];
      }
    }
  }

  doc.tags = [...usedTags].sort().map((name) => ({ name }));

  if (prisma) {
    const layers = await prisma.layer.findMany({
      where: { kind: 'BASE' },
      select: { slug: true },
      orderBy: { slug: 'asc' },
    });
    injectOsSlugEnum(
      doc,
      layers.map((l) => l.slug),
    );
  }

  return doc;
}

function injectOsSlugEnum(node: unknown, slugs: string[]): void {
  if (Array.isArray(node)) {
    for (const element of node) {
      injectOsSlugEnum(element, slugs);
    }
    return;
  }
  if (!isRecord(node)) return;
  if (
    typeof node.description === 'string' &&
    node.description.startsWith(OS_SLUG_DESCRIPTION_MARKER) &&
    node.type === 'string' &&
    slugs.length > 0
  ) {
    node.enum = slugs;
  }
  for (const value of Object.values(node)) {
    injectOsSlugEnum(value, slugs);
  }
}
