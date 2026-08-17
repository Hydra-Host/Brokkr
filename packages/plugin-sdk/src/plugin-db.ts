export const PLUGIN_PRISMA_CLIENT = Symbol.for('@hydrahost/plugin-sdk/PRISMA_CLIENT');

/** Trust boundary: the unrestricted host `PrismaClient` — no per-plugin schema isolation or tenant scoping; pass dynamic values as positional parameters, never interpolate untrusted input. */
export interface PluginDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}
