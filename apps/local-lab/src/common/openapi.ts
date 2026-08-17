import { generateOpenApi } from '@ts-rest/open-api';

import { contract } from '../contract';

const API_DESCRIPTION = `# Brokkr Local — Lab Control-Center API

Programmatic surface for driving the sim fleet without the Taskfile:
stack/services control, fleet machines (power/discover/reset/exec/console),
test runner, layer cache, datastore peek, and config CRUD.

Live spec at \`/api/swagger-json\`, Swagger UI at \`/api/swagger\`,
ReDoc at \`/api/redoc\`. Mirrors the hub's pattern (\`@ts-rest/open-api\` +
\`@nestjs/swagger\`) so any ts-rest contract entry shows up in docs
automatically — no JSDoc / decorator duplication.`;

function titleize(segment: string): string {
  return segment
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function deriveTag(path: string): string {
  const seg = path.replace(/^\/api\/?/, '').split('/')[0] || 'General';
  return titleize(seg);
}

export function generateLabApiDocument() {
  const doc = generateOpenApi(
    contract,
    {
      info: {
        title: 'Brokkr Local — Lab API',
        description: API_DESCRIPTION,
        version: '0.1.0',
      },
      servers: [{ url: '/', description: 'Lab API' }],
    },
    {
      setOperationId: true,
      operationMapper: (operation, appRoute) => ({
        ...operation,
        tags: [deriveTag(appRoute.path)],
      }),
    },
  );

  const seen = new Set<string>();
  for (const item of Object.values(doc.paths ?? {})) {
    if (!item) continue;
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const op = item[method] as { tags?: string[] } | undefined;
      for (const t of op?.tags ?? []) seen.add(t);
    }
  }
  doc.tags = [...seen].sort().map((name) => ({ name }));

  return doc;
}
