/**
 * The SQL editor: runs one read query typed by the user.
 *
 * This is the only place PG Studio sends SQL text that came from a request,
 * so it stacks several guards on top of the read-only role:
 *
 * - One statement only. The query goes over the extended protocol, which
 *   Postgres refuses to run with more than one command in it, so text such
 *   as "SELECT 1; COMMIT; DELETE ..." fails as a whole.
 * - Always inside a subquery: SELECT * FROM (<query>) LIMIT n. The top level
 *   is always a SELECT, so SET, BEGIN/COMMIT, INSERT/UPDATE/DELETE and
 *   data-modifying WITH clauses can't run, whatever the text says.
 * - A READ ONLY transaction that is always rolled back, with its own timeout,
 *   on a connection that is closed afterwards so no session state survives.
 * - Never for superuser connections: those can reach the server's files and
 *   other databases through functions that a read-only transaction allows.
 *
 * None of this replaces a SELECT-only role, which is still the boundary.
 */
import pg from "pg";
import type { Config } from "./config.js";
import { HttpError } from "./errors.js";
import type { Scope } from "./pools.js";
import type { ExportResult } from "./rows.js";
import { prepareSql, type SqlMode } from "./sqltext.js";

const q = pg.escapeIdentifier;

/** Every value as Postgres text output, the same format the table grid shows. */
const RAW_TEXT: pg.CustomTypesConfig = {
  getTypeParser: (() => (value: string) => value) as unknown as pg.CustomTypesConfig["getTypeParser"],
};

const WRAP_OPEN = "SELECT * FROM (\n";
const WRAP_CLOSE = "\n) AS pgstudio_query";

/** A Postgres error caused by the query itself, shown to the user as is. */
export class SqlError extends Error {
  constructor(
    message: string,
    /** Character offset in the editor text, when Postgres reported one. */
    readonly position: number | null,
    readonly detail: string | null,
    readonly hint: string | null,
  ) {
    super(message);
  }
}

export interface SqlColumn {
  name: string;
  type: string;
  numeric: boolean;
}

export type SqlResult =
  | {
      kind: "rows";
      columns: SqlColumn[];
      rows: (string | null)[][];
      /** [rowIndex, columnIndex] pairs whose value was cut at the char limit. */
      truncated: [number, number][];
      /** True when the query returned more rows than `rowLimit`. */
      limitHit: boolean;
      rowLimit: number;
      ms: number;
    }
  | { kind: "plan"; plan: string; analyze: boolean; ms: number };

interface RunOptions {
  text: string;
  mode: SqlMode;
  /** Schema to put first on the search path, so unqualified names resolve like in the sidebar. */
  schema: string | null;
  maxRows: number;
  charLimit: number;
  /** Called with the backend pid once known, so the caller can cancel the query. */
  onBackend?: (pid: number) => void;
}

/** Connection, authentication and server-state errors keep their usual generic handling. */
function isQueryError(err: unknown): err is pg.DatabaseError {
  const code = (err as { code?: unknown } | null)?.code;
  if (!(err instanceof pg.DatabaseError) || typeof code !== "string") return false;
  return !/^(08|28|3D|53|57P|XX)/.test(code);
}

function toSqlError(err: pg.DatabaseError, textOffset: number, timeoutMs: number): SqlError {
  if (err.code === "57014") {
    const timedOut = /statement timeout/.test(err.message);
    return new SqlError(
      timedOut ? `The query ran longer than ${timeoutMs / 1000}s and was stopped (SQL_TIMEOUT_MS).` : "The query was cancelled.",
      null,
      null,
      null,
    );
  }
  let hint = err.hint ?? null;
  if (err.code === "25006" || /data-modifying statement/.test(err.message)) {
    hint = "The SQL editor runs read queries only, in a read-only transaction.";
  }
  const pos = err.position ? Number(err.position) - 1 - textOffset : NaN;
  return new SqlError(err.message, Number.isInteger(pos) && pos >= 0 ? pos : null, err.detail ?? null, hint);
}

export async function runSql(scope: Scope, config: Config, opts: RunOptions): Promise<SqlResult> {
  let prepared;
  try {
    prepared = prepareSql(opts.text, opts.mode);
  } catch (err) {
    throw new SqlError((err as Error).message, null, null, null);
  }
  const { body, offset, mode, verbose } = prepared;

  let prefix = "";
  if (mode !== "run") {
    const options = ["FORMAT TEXT"];
    if (mode === "analyze") options.push("ANALYZE", "BUFFERS");
    if (verbose) options.push("VERBOSE");
    prefix = `EXPLAIN (${options.join(", ")}) `;
  }
  const limit = mode === "run" ? ` LIMIT ${Math.trunc(opts.maxRows) + 1}` : "";
  const text = `${prefix}${WRAP_OPEN}${body}${WRAP_CLOSE}${limit}`;
  // Postgres reports positions in `text`; the user's text starts after the prefix and wrapper.
  const textOffset = prefix.length + WRAP_OPEN.length - offset;

  return scope.db.withReadOnly(
    async (c) => {
      const who = await c.query<{ pid: number; su: string }>(
        "SELECT pg_backend_pid() AS pid, current_setting('is_superuser') AS su",
      );
      if (who.rows[0]?.su === "on") {
        throw new HttpError(
          403,
          "The SQL editor is off for superuser connections. Connect with a read-only role (see the README).",
        );
      }
      if (who.rows[0]) opts.onBackend?.(who.rows[0].pid);
      if (opts.schema) {
        const path = opts.schema === "public" ? "public" : `${q(opts.schema)}, public`;
        await c.query("SELECT set_config('search_path', $1, true)", [path]);
      }

      const started = performance.now();
      let res: pg.QueryArrayResult<(string | null)[]>;
      try {
        const query = { text, rowMode: "array", types: RAW_TEXT, queryMode: "extended" } as pg.QueryArrayConfig;
        res = await c.query<(string | null)[]>(query);
      } catch (err) {
        if (isQueryError(err)) throw toSqlError(err, textOffset, config.sqlTimeoutMs);
        throw err;
      }
      const ms = Math.round(performance.now() - started);

      if (mode !== "run") {
        return { kind: "plan", plan: res.rows.map((r) => r[0] ?? "").join("\n"), analyze: mode === "analyze", ms };
      }

      const oids = [...new Set(res.fields.map((f) => f.dataTypeID))];
      const types = await c.query<{ oid: number; name: string; cat: string }>(
        `SELECT t.oid::int AS oid, format_type(t.oid, NULL) AS name, t.typcategory::text AS cat
           FROM pg_catalog.pg_type t WHERE t.oid = ANY($1::oid[])`,
        [oids],
      );
      const byOid = new Map(types.rows.map((t) => [t.oid, t]));
      const columns = res.fields.map((f) => ({
        name: f.name,
        type: byOid.get(f.dataTypeID)?.name ?? "unknown",
        numeric: byOid.get(f.dataTypeID)?.cat === "N",
      }));

      const limitHit = res.rows.length > opts.maxRows;
      const truncated: [number, number][] = [];
      const rows = res.rows.slice(0, opts.maxRows).map((row, r) =>
        row.map((v, i) => {
          if (v !== null && v.length > opts.charLimit) {
            truncated.push([r, i]);
            return v.slice(0, opts.charLimit);
          }
          return v;
        }),
      );
      return { kind: "rows", columns, rows, truncated, limitHit, rowLimit: opts.maxRows, ms };
    },
    { timeoutMs: config.sqlTimeoutMs, discard: true },
  );
}

/** Column names made unique (id, id_2, ...) so JSON objects don't lose values. */
function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const k = (seen.get(n) ?? 0) + 1;
    seen.set(n, k);
    return k === 1 ? n : `${n}_${k}`;
  });
}

/** Run the query again for a CSV/JSON download, with the export limits. */
export async function exportSql(
  scope: Scope,
  config: Config,
  text: string,
  schema: string | null,
): Promise<ExportResult> {
  const result = await runSql(scope, config, {
    text,
    mode: "run",
    schema,
    maxRows: config.exportMaxRows,
    charLimit: config.exportCellCharLimit,
  });
  if (result.kind !== "rows") throw new SqlError("Remove EXPLAIN to download the query's rows.", null, null, null);
  return {
    columns: uniqueNames(result.columns.map((c) => c.name)),
    rows: result.rows,
    limitHit: result.limitHit,
    cutCells: result.truncated.length,
  };
}
