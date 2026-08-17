import { createPrismaClient } from '@repo/database';
import { fileURLToPath } from 'url';

type PrismaClient = ReturnType<typeof createPrismaClient>;

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://brokkr:password@localhost:5432/brokkr';

export async function cleanup(prisma: PrismaClient): Promise<void> {
  await prisma.member.deleteMany({
    where: {
      user: {
        email: { endsWith: '@test.brokkr.local' },
      },
    },
  });

  await prisma.account.deleteMany({
    where: {
      user: {
        email: { endsWith: '@test.brokkr.local' },
      },
    },
  });

  await prisma.session.deleteMany({
    where: {
      user: {
        email: { endsWith: '@test.brokkr.local' },
      },
    },
  });

  await prisma.user.deleteMany({
    where: {
      email: { endsWith: '@test.brokkr.local' },
    },
  });

  await prisma.organization.deleteMany({
    where: {
      name: { startsWith: 'E2E Test Org' },
    },
  });

  console.log('Cleanup complete.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const prisma = createPrismaClient({ connectionString: DATABASE_URL });
  cleanup(prisma)
    .catch((err) => {
      console.error('Cleanup failed:', err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
