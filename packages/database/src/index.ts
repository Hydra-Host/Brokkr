import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/client/index.js';

export * from '../generated/client/index.js';
export { PrismaPg };

type PrismaConstructorOptions = NonNullable<ConstructorParameters<typeof PrismaClient>[0]>;
type PrismaLogOptions = PrismaConstructorOptions['log'];

export interface CreatePrismaClientOptions {
  connectionString: string;
  log?: PrismaLogOptions;
}

export const createPrismaClientOptions = ({
  connectionString,
  log,
}: CreatePrismaClientOptions): PrismaConstructorOptions => ({
  adapter: new PrismaPg({ connectionString }),
  ...(log ? { log } : {}),
});

export const createPrismaClient = (options: CreatePrismaClientOptions): PrismaClient =>
  new PrismaClient(createPrismaClientOptions(options));
