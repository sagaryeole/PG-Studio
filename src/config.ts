/**
 * Runtime configuration. Everything comes from the environment (and an
 * optional connections file); nothing is hard-coded and connection strings
 * are never logged or sent to the browser.
 */
import fs from "node:fs";
import path from "node:path";
import { parseIntoClientConfig } from "pg-connection-string";

/** One saved connection. `url` holds credentials and never leaves the server. */
export interface Connection {
  /** URL-safe id derived from the name; what the browser sends back. */
  readonly id: string;
  readonly name: string;
  readonly url: string;
  /** Schema to open first; falls back to PG_SCHEMA. */
  readonly schema: string | null;
}

export interface Config {
  /** At least one. The first is the default. */
  readonly connections: readonly Connection[];
  /** Where the connections came from, for the startup log. */
  readonly connectionsSource: string;
  /**
   * 127.0.0.1, except in the official container image (PG_STUDIO_CONTAINER=1),
   * where the app must listen on all interfaces of the container so Docker
   * can forward a port to it. Publish that port to localhost only.
   */
  readonly host: "127.0.0.1" | "0.0.0.0";
  /** Container mode: the browser reaches us through a published port that may differ from PORT. */
  readonly container: boolean;
  readonly port: number;
  readonly schema: string;
  readonly statementTimeoutMs: number;
  readonly pageSizeDefault: number;
  readonly pageSizeMax: number;
  /** Max characters returned per cell; longer values are cut server-side. */
  readonly cellCharLimit: number;
  /** Max rows in one CSV/JSON export. */
  readonly exportMaxRows: number;
  /** Max characters per cell in an export (higher than the grid's limit). */
  readonly exportCellCharLimit: number;
  /** The SQL editor (read queries only). SQL_EDITOR=off removes it. */
  readonly sqlEditor: boolean;
  /** Statement timeout for queries typed in the SQL editor. */
  readonly sqlTimeoutMs: number;
  /** Max rows the SQL editor shows. */
  readonly sqlMaxRows: number;
}

const MAX_CONNECTIONS = 50;

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be a positive integer`);
  }
  const n = Number(raw);
  if (n < min || n > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return n;
}

function isPostgresUrl(url: string): boolean {
  return /^postgres(?:ql)?:\/\//i.test(url);
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "connection"
  );
}

/**
 * Read the connections file: a JSON array (or `{ "connections": [...] }`) of
 * `{ "name": "...", "url": "postgres://...", "schema": "public" }`.
 * Returns null when the file doesn't exist.
 */
function readConnectionsFile(file: string): { name: string; url: string; schema: string | null }[] | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return null;
    throw new Error(`Cannot read ${file}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Don't echo the parser message: it can quote part of a password.
    throw new Error(`${file} is not valid JSON`);
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { connections?: unknown } | null)?.connections;
  if (!Array.isArray(list)) throw new Error(`${file} must be a JSON array of connections`);

  const connections = list.map((raw, i) => {
    const c = raw as { name?: unknown; url?: unknown; schema?: unknown } | null;
    const where = `${file}, connection ${i + 1}`;
    if (typeof c?.name !== "string" || !c.name.trim() || c.name.length > 80) {
      throw new Error(`${where}: "name" must be a non-empty string (max 80 characters)`);
    }
    if (typeof c.url !== "string" || !isPostgresUrl(c.url)) {
      throw new Error(`${where}: "url" must be a postgres:// connection string`);
    }
    if (c.schema !== undefined && (typeof c.schema !== "string" || !c.schema.trim())) {
      throw new Error(`${where}: "schema" must be a non-empty string when given`);
    }
    return { name: c.name.trim(), url: c.url, schema: typeof c.schema === "string" ? c.schema.trim() : null };
  });

  // Passwords in this file: nag like ssh does when other users can read it.
  // (Passwordless URLs that rely on ~/.pgpass or PGPASSWORD don't need it.)
  try {
    const hasPassword = connections.some((c) => !!parseIntoClientConfig(c.url).password);
    if (hasPassword && process.platform !== "win32" && (fs.statSync(file).mode & 0o077) !== 0) {
      console.warn(`  WARNING: ${file} holds passwords and other users can read it. Run: chmod 600 ${file}`);
    }
  } catch {
    /* best effort */
  }
  return connections;
}

function loadConnections(): { connections: Connection[]; source: string } {
  const file = path.resolve(process.env["CONNECTIONS_FILE"]?.trim() || "connections.json");
  const fromFile = readConnectionsFile(file) ?? [];
  const sources: string[] = [];
  if (fromFile.length) sources.push(path.relative(process.cwd(), file) || file);

  const raw = [...fromFile];
  const envUrl = process.env["DATABASE_URL"]?.trim();
  if (envUrl) {
    if (!isPostgresUrl(envUrl)) throw new Error("DATABASE_URL must be a postgres:// connection string");
    // DATABASE_URL stays the default so existing setups behave exactly as before.
    raw.unshift({ name: process.env["DATABASE_LABEL"]?.trim() || "Default", url: envUrl, schema: null });
    sources.unshift("DATABASE_URL");
  }

  if (raw.length === 0) {
    throw new Error(
      "No database configured. Set DATABASE_URL in .env (copy .env.example), " +
        "or list connections in connections.json (see connections.example.json).",
    );
  }
  if (raw.length > MAX_CONNECTIONS) throw new Error(`At most ${MAX_CONNECTIONS} connections`);

  const used = new Set<string>();
  const connections = raw.map((c) => {
    let id = slug(c.name);
    for (let n = 2; used.has(id); n++) id = `${slug(c.name)}-${n}`;
    used.add(id);
    return { id, ...c };
  });
  return { connections, source: sources.join(" + ") };
}

function flagFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["1", "on", "true", "yes"].includes(raw)) return true;
  if (["0", "off", "false", "no"].includes(raw)) return false;
  throw new Error(`${name} must be on or off`);
}

export function loadConfig(): Config {
  const container = process.env["PG_STUDIO_CONTAINER"] === "1";
  const schema = (process.env["PG_SCHEMA"] ?? "public").trim() || "public";
  const { connections, source } = loadConnections();

  return {
    connections,
    connectionsSource: source,
    host: container ? "0.0.0.0" : "127.0.0.1",
    container,
    port: intFromEnv("PORT", 4321, 1024, 65535),
    schema,
    statementTimeoutMs: intFromEnv("STATEMENT_TIMEOUT_MS", 5000, 100, 120_000),
    pageSizeDefault: 50,
    pageSizeMax: 100,
    cellCharLimit: 5000,
    exportMaxRows: intFromEnv("EXPORT_MAX_ROWS", 10_000, 1, 100_000),
    exportCellCharLimit: 100_000,
    sqlEditor: flagFromEnv("SQL_EDITOR", true),
    sqlTimeoutMs: intFromEnv("SQL_TIMEOUT_MS", 30_000, 100, 600_000),
    sqlMaxRows: intFromEnv("SQL_MAX_ROWS", 1000, 1, 10_000),
  };
}
