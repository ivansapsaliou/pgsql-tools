"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.connect = connect;
exports.disconnect = disconnect;
exports.query = query;
const pg_1 = require("pg");
/**
 * Creates and connects a pg.Client from a connection URL or env DATABASE_URL.
 * The caller is responsible for ending the client.
 */
async function connect(url) {
    const config = { connectionString: url };
    const client = new pg_1.Client(config);
    try {
        await client.connect();
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to connect to PostgreSQL: ${message}`);
    }
    return client;
}
/** Safely ends a client, ignoring any disconnect errors. */
async function disconnect(client) {
    try {
        await client.end();
    }
    catch {
        // ignore
    }
}
/** Run a query and return rows, throwing a human-readable error on failure. */
async function query(client, sql, params = []) {
    try {
        const result = await client.query(sql, params);
        return result.rows;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Query failed: ${message}`);
    }
}
//# sourceMappingURL=db.js.map