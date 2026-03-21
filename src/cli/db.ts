import { Client, ClientConfig } from 'pg';

/**
 * Creates and connects a pg.Client from a connection URL or env DATABASE_URL.
 * The caller is responsible for ending the client.
 */
export async function connect(url: string): Promise<Client> {
  const config: ClientConfig = { connectionString: url };
  const client = new Client(config);
  try {
    await client.connect();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to connect to PostgreSQL: ${message}`);
  }
  return client;
}

/** Safely ends a client, ignoring any disconnect errors. */
export async function disconnect(client: Client): Promise<void> {
  try {
    await client.end();
  } catch {
    // ignore
  }
}

/** Run a query and return rows, throwing a human-readable error on failure. */
export async function query<T = Record<string, unknown>>(
  client: Client,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  try {
    const result = await client.query(sql, params);
    return result.rows as T[];
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Query failed: ${message}`);
  }
}
