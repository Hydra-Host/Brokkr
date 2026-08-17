import { createPrismaClient } from '@repo/database';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { cleanup } from './cleanup.js';
import { createTestOrganization } from './organizations.js';
import { createTestUsers } from './users.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://brokkr:password@localhost:5432/brokkr';
const API_URL = process.env.API_URL ?? 'http://localhost:3000';

export async function runSeed(): Promise<void> {
  const prisma = createPrismaClient({ connectionString: DATABASE_URL });

  try {
    console.log('Running cleanup...');
    await cleanup(prisma);

    console.log('Creating test users...');
    await createTestUsers(API_URL);

    console.log('Creating test organization...');
    const organization = await createTestOrganization(prisma);

    const seedResult = {
      users: {
        standard: {
          email: 'e2e-standard@test.brokkr.local',
          password: 'TestPassword123!',
        },
        orguser: {
          email: 'e2e-orguser@test.brokkr.local',
          password: 'TestPassword123!',
        },
      },
      organization,
    };

    const resultPath = path.resolve(__dirname, '..', '.seed-result.json');
    fs.writeFileSync(resultPath, JSON.stringify(seedResult, null, 2));
    console.log(`Seed result written to ${resultPath}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSeed().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
}
