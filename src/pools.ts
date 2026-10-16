/**
 * Connections and databases. A PostgreSQL connection only sees one database,
 * so browsing another database on the same server needs its own pool. Pools
 * are opened on first use, and only for databases the role may CONNECT to.
 *
 * The browser picks a scope with ?conn=<id>&db=<name>. Both are checked
 * against server-side lists; credentials never leave this module.
 */
import type { Request } from "express";
import type pg from "pg";
import { parseIntoClientConfig } from "pg-connection-string";
import type { Config, Connection } from "./config.js";
import { createDb, type Db } from "./db.js";
import { HttpError } from "./errors.js";

export interface DatabaseSummary {
  name: string;
  /** null when the size isn't visible to this role. */
  sizeBytes: number | null;
}

export interface Scope {
  connection: Connection;
  database: string;
  db: Db;
}

/** Open pools beyond the default ones are closed least-recently-used first. */
const MAX_EXTRA_POOLS = 6;
const DB_LIST_TTL_MS = 30_000;
const MAX_NAME = 63 * 4;

const DATABASES_SQL = `
  SELECT d.datname AS name, pg_database_size(d.oid) AS size_bytes
    FROM pg_catalog.pg_database d
   WHERE d.datallowconn
     AND NOT d.datistemplate
     AND has_database_privilege(d.oid, 'CONNECT')
   ORDER BY d.datname`;

function param(req: Request, name: string): string | undefined {
  const raw = req.query[name];
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > MAX_NAME) throw new HttpError(400, `Invalid ${name}`);
  return raw;
}

export class Pools {
  private readonly defaults = new Map<string, Db>();
  /** current_database() of each connection's default pool. */
  private readonly defaultNames = new Map<string, Promise<string>>();
  /** Extra pools keyed by connection id + database; Map order = least recently used first. */
  private readonly extra = new Map<string, Db>();
  private readonly dbLists = new Map<string, { at: number; list: Promise<DatabaseSummary[]> }>();

  constructor(private readonly config: Config) {}

  get connections(): readonly Connection[] {
    return this.config.connections;
  }

  connection(id: string | undefined): Connection {
    const list = this.config.connections;
    const conn = id === undefined ? list[0] : list.find((c) => c.id === id);
    if (!conn) throw new HttpError(404, "Connection not found");
    return conn;
  }

  /** The pool for a connection's own database (the one in its URL). */
  defaultDb(conn: Connection): Db {
    let db = this.defaults.get(conn.id);
    if (!db) {
      db = createDb(parseIntoClientConfig(conn.url), this.config.statementTimeoutMs);
      this.defaults.set(conn.id, db);
    }
    return db;
  }

  defaultDatabase(conn: Connection): Promise<string> {
    let name = this.defaultNames.get(conn.id);
    if (!name) {
      name = this.defaultDb(conn).withReadOnly(async (c) => {
        const r = await c.query<{ db: string }>("SELECT current_database() AS db");
        return r.rows[0]?.db ?? "";
      });
      name.catch(() => this.defaultNames.delete(conn.id)); // retry after a failed connect
      this.defaultNames.set(conn.id, name);
    }
    return name;
  }

  /** Databases on the connection's server that the role may connect to. Cached briefly. */
  listDatabases(conn: Connection): Promise<DatabaseSummary[]> {
    const hit = this.dbLists.get(conn.id);
    if (hit && Date.now() - hit.at < DB_LIST_TTL_MS) return hit.list;
    const list = this.defaultDb(conn).withReadOnly(async (c) => {
      const r = await c.query<{ name: string; size_bytes: string | null }>(DATABASES_SQL);
      return r.rows.map((row) => ({
        name: row.name,
        sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
      }));
    });
    list.catch(() => this.dbLists.delete(conn.id));
    this.dbLists.set(conn.id, { at: Date.now(), list });
    return list;
  }

  /** Resolve ?conn= and ?db= to a pool. Unknown or not-allowed names are a 404. */
  async forRequest(req: Request): Promise<Scope> {
    const connection = this.connection(param(req, "conn"));
    const wanted = param(req, "db");
    const own = await this.defaultDatabase(connection);
    if (wanted === undefined || wanted === own) {
      return { connection, database: own, db: this.defaultDb(connection) };
    }

    const allowed = await this.listDatabases(connection);
    if (!allowed.some((d) => d.name === wanted)) throw new HttpError(404, "Database not found");

    const key = `${connection.id}\u0000${wanted}`;
    let db = this.extra.get(key);
    if (db) {
      this.extra.delete(key); // re-insert to mark as most recently used
    } else {
      db = createDb(
        { ...parseIntoClientConfig(connection.url), database: wanted },
        this.config.statementTimeoutMs,
        3,
      );
      while (this.extra.size >= MAX_EXTRA_POOLS) {
        const [oldKey, oldDb] = this.extra.entries().next().value as [string, Db];
        this.extra.delete(oldKey);
        void oldDb.close().catch(() => undefined);
      }
    }
    this.extra.set(key, db);
    return { connection, database: wanted, db };
  }

  async closeAll(): Promise<void> {
    const all = [...this.defaults.values(), ...this.extra.values()];
    await Promise.allSettled(all.map((db) => db.close()));
  }
}

/** What the browser may know about a connection: no password, ever. */
export function describeConnection(conn: Connection): {
  id: string;
  name: string;
  user: string | null;
  host: string | null;
  port: number | null;
} {
  const cfg: pg.ClientConfig = parseIntoClientConfig(conn.url);
  return {
    id: conn.id,
    name: conn.name,
    user: typeof cfg.user === "string" ? cfg.user : null,
    host: typeof cfg.host === "string" ? cfg.host : null,
    port: typeof cfg.port === "number" ? cfg.port : cfg.port ? Number(cfg.port) : null,
  };
}
