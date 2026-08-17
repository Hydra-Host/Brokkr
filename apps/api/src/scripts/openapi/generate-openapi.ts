import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getStaticRedocHtml } from '../../common/docs-html';
import { generateApiDocument } from '../../common/openapi';

async function generateOpenApiSpec() {
  const outputDir = path.resolve(process.cwd(), 'openapi');
  await mkdir(outputDir, { recursive: true });

  const publicDoc = await generateApiDocument(null, ['public']);
  const specJson = JSON.stringify(publicDoc, null, 2);
  const specPath = path.join(outputDir, 'public.json');

  await writeFile(specPath, specJson, 'utf8');
  console.log(`OpenAPI document generated at ${specPath}`);

  const html = getStaticRedocHtml(JSON.stringify(publicDoc));
  const htmlPath = path.join(outputDir, 'index.html');

  await writeFile(htmlPath, html, 'utf8');
  console.log(`Static HTML docs generated at ${htmlPath}`);
}

const isSeedScript = process.argv.includes('--seed-script');
if (isSeedScript) {
  void generateOpenApiSpec();
}
