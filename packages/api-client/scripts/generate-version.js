const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const major = pkg.version.split('.')[0];

const content = `// Auto-generated from package.json version (${pkg.version})
// Do not edit manually — run "pnpm generate:version" to regenerate
export const API_VERSION = 'v${major}';
export const API_PREFIX = '/api/v${major}';
`;

fs.writeFileSync(path.join(__dirname, '..', 'src', 'version.ts'), content);
console.log(`Generated version.ts: API_PREFIX = /api/v${major} (from ${pkg.version})`);
