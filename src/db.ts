/**
 * Database access. Every read goes through `withReadOnly`, which opens a
 * READ ONLY transaction with a statement timeout and always rolls back.
 *
 * Edit seam (future): add a `withWrite` helper here that uses a SEPARATE pool
 * built from DATABASE_WRITE_URL (a role with UPDATE on specific tables only).
 * Keep the two pools separate so the read path can never be upgraded to a
 * writable connection by mistake.
 */
import pg from "pg";
import type { Config } from "./config.js";

export type Db = {
  withReadOnly<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export function createDb(config: Config): Db {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "pg-studio (read-only)",
  });

  // Log pool errors without the connection string or any credentials.
  pool.on("error", (err) => {
    console.error("[db] idle client error:", redact(err));
  });

  return {
    async withReadOnly<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        // NOTE: READ ONLY is a guard rail, not a security boundary. A multi-statement
        // string such as "COMMIT; DELETE ..." escapes it. That is why the app never
        // runs request-derived SQL text and why a SELECT-only role is required.
        await client.query("BEGIN TRANSACTION READ ONLY");
        await client.query("SELECT set_config('statement_timeout', $1, true)", [
          String(Math.trunc(config.statementTimeoutMs)),
        ]);
        return await fn(client);
      } finally {
        // Always roll back: nothing in the read path should ever commit.
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Strip anything that looks like a connection string from an error message. */
export function redact(err: unknown): string {
  // AggregateError (what Node throws when "localhost" fails on both ::1 and
  // 127.0.0.1) has an empty message, so describe each inner error as well.
  const describe = (e: unknown): string[] => {
    const x = e as { code?: unknown; message?: unknown; address?: unknown; port?: unknown; errors?: unknown } | null;
    const out: string[] = [];
    const head = [
      typeof x?.code === "string" ? x.code : "",
      typeof x?.address === "string" ? `${x.address}${typeof x.port === "number" ? `:${x.port}` : ""}` : "",
      e instanceof Error && e.message ? e.message : typeof e === "string" ? e : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (head) out.push(head);
    if (Array.isArray(x?.errors)) for (const sub of x.errors) out.push(...describe(sub));
    return out;
  };
  const text = describe(err).join(" | ") || "unknown error";
  return text.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "postgres://[redacted]");
}
