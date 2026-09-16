import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/js/client.js';

export * from '../generated/js/client.js';
export { PrismaPg };

export interface CreatePrismaClientOptions {
  connectionString: string;
  log?: Prisma.PrismaClientOptions['log'];
}

export const createPrismaClientOptions = ({ connectionString, log }: CreatePrismaClientOptions) => ({
  adapter: new PrismaPg({ connectionString }),
  ...(log ? { log } : {}),
});

export const createPrismaClient = (options: CreatePrismaClientOptions): PrismaClient =>
  new PrismaClient(createPrismaClientOptions(options));
