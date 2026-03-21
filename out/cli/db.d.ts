import { Client } from 'pg';
/**
 * Creates and connects a pg.Client from a connection URL or env DATABASE_URL.
 * The caller is responsible for ending the client.
 */
export declare function connect(url: string): Promise<Client>;
/** Safely ends a client, ignoring any disconnect errors. */
export declare function disconnect(client: Client): Promise<void>;
/** Run a query and return rows, throwing a human-readable error on failure. */
export declare function query<T = Record<string, unknown>>(client: Client, sql: string, params?: unknown[]): Promise<T[]>;
//# sourceMappingURL=db.d.ts.map