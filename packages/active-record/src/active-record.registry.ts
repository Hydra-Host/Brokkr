import { Prisma, PrismaClient } from '@repo/database';
import type { ActiveRecordContext, ContextProvider } from './active-record.context';

export class ActiveRecordRegistry {
  private static _client: PrismaClient | null = null;
  private static _contextProvider: ContextProvider | null = null;

  static configure(client: PrismaClient, contextProvider?: ContextProvider): void {
    this._client = client;
    if (contextProvider) {
      this._contextProvider = contextProvider;
    }
  }

  static configureForTest(client: unknown, contextProvider?: ContextProvider | null): void {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'ActiveRecordRegistry.configureForTest() is a test-only escape hatch and must not be called in production. ' +
          'Configure the registry via ActiveRecordModule.forRoot() instead.',
      );
    }
    this._client = client as PrismaClient;
    if (contextProvider !== undefined) {
      this._contextProvider = contextProvider;
    }
  }

  static get client(): PrismaClient {
    if (!this._client) {
      throw new Error(
        'ActiveRecordRegistry has not been configured. ' +
          'Ensure ActiveRecordModule.forRoot() is imported before use.',
      );
    }
    return this._client;
  }

  static get context(): ActiveRecordContext | undefined {
    return this._contextProvider?.();
  }

  static transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.client.$transaction(fn);
  }
}
