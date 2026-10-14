/**
 * Runtime configuration. Everything comes from the environment; nothing is
 * hard-coded and the connection string is never logged.
 */

export interface Config {
  readonly databaseUrl: string;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly schema: string;
  readonly statementTimeoutMs: number;
  readonly pageSizeDefault: number;
  readonly pageSizeMax: number;
  /** Max characters returned per cell; longer values are cut server-side. */
  readonly cellCharLimit: number;
}

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

export function loadConfig(): Config {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  }

  const schema = (process.env["PG_SCHEMA"] ?? "public").trim() || "public";

  return {
    databaseUrl,
    host: "127.0.0.1",
    port: intFromEnv("PORT", 4321, 1024, 65535),
    schema,
    statementTimeoutMs: intFromEnv("STATEMENT_TIMEOUT_MS", 5000, 100, 120_000),
    pageSizeDefault: 50,
    pageSizeMax: 100,
    cellCharLimit: 5000,
  };
}
