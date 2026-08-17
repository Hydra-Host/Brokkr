import pg from 'pg';

const DEFAULT_SERVER_URL = 'postgresql://brokkr:password@localhost:5432/postgres';
const serverUrl = process.env.E2E_DATABASE_SERVER_URL ?? DEFAULT_SERVER_URL;
const connectAttempts = Number(process.env.E2E_DATABASE_CONNECT_ATTEMPTS ?? 30);
const connectRetryDelayMs = Number(process.env.E2E_DATABASE_CONNECT_RETRY_MS ?? 1_000);

export interface E2eDatabase {
  name: string;
  databaseUrl: string;
}

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function validateConnection(): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= connectAttempts; attempt += 1) {
    const client = new pg.Client({ connectionString: serverUrl });
    try {
      await client.connect();
      return;
    } catch (error) {
      lastError = error;
    } finally {
      await client.end().catch(() => undefined);
    }

    if (attempt < connectAttempts) {
      await sleep(connectRetryDelayMs);
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error('Unable to connect to PostgreSQL');
}

async function createServerClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: serverUrl });
  await client.connect();
  return client;
}

export async function createE2eDatabase(): Promise<E2eDatabase> {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  const name = `brokkr_e2e_${timestamp}_${random}`;

  const client = await createServerClient();
  try {
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }

  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const databaseUrl = url.toString();

  return { name, databaseUrl };
}

export async function dropE2eDatabase(db: E2eDatabase): Promise<void> {
  const client = await createServerClient();
  try {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [db.name],
    );
    await client.query(`DROP DATABASE "${db.name}"`);
  } finally {
    await client.end();
  }
}

export async function listE2eDatabases(): Promise<string[]> {
  const client = await createServerClient();
  try {
    const result = await client.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE 'brokkr_e2e_%' ORDER BY datname`,
    );
    return result.rows.map((row) => row.datname);
  } finally {
    await client.end();
  }
}
