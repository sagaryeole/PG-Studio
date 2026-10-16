import express, { Router, type Request, type Response } from "express";
import type { Config } from "../config.js";
import { redact } from "../db.js";
import { HttpError } from "../errors.js";
import type { Pools, Scope } from "../pools.js";
import { toCsv, toJson } from "../rows.js";
import { exportSql, runSql, SqlError } from "../sql.js";
import type { SqlMode } from "../sqltext.js";

const MAX_SQL = 100_000;
const MAX_IDENT = 63 * 4;
const MODES = new Set<SqlMode>(["run", "explain", "analyze"]);

interface SqlBody {
  sql: string;
  mode: SqlMode;
  schema: string | null;
}

function parseBody(req: Request): SqlBody {
  const b = req.body as { sql?: unknown; mode?: unknown; schema?: unknown } | undefined;
  if (!b || typeof b !== "object") throw new HttpError(400, "Send the query as JSON");
  if (typeof b.sql !== "string" || b.sql.length > MAX_SQL) {
    throw new HttpError(400, `sql must be text of at most ${MAX_SQL.toLocaleString("en-US")} characters`);
  }
  const mode = b.mode ?? "run";
  if (typeof mode !== "string" || !MODES.has(mode as SqlMode)) throw new HttpError(400, "mode must be run, explain or analyze");
  const schema = b.schema ?? null;
  if (schema !== null && (typeof schema !== "string" || schema.length === 0 || schema.length > MAX_IDENT)) {
    throw new HttpError(400, "Invalid schema");
  }
  return { sql: b.sql, mode: mode as SqlMode, schema };
}

function sendSqlError(res: Response, err: SqlError): void {
  res.status(400).json({ error: err.message, position: err.position, detail: err.detail, hint: err.hint });
}

/**
 * Stop the query on the server when the browser gives up on it (Cancel
 * button, closed tab). Otherwise it would keep running until its timeout.
 */
function cancelOnDisconnect(res: Response, scope: Scope): (pid: number) => void {
  let pid: number | null = null;
  res.on("close", () => {
    if (res.writableFinished || pid === null) return;
    const target = pid;
    scope.db
      .withReadOnly((c) => c.query("SELECT pg_cancel_backend($1)", [target]))
      .catch((err: unknown) => console.error("[sql] cancel failed:", redact(err)));
  });
  return (p) => {
    pid = p;
  };
}

/** The read-only SQL editor. Mounted only when SQL_EDITOR is on. */
export function sqlRoutes(config: Config, pools: Pools): Router {
  const r = Router();
  // POST, so the same-origin check in security.ts applies; JSON only, so a
  // cross-site form can't send it without a CORS preflight.
  r.use("/sql", express.json({ limit: "256kb", type: "application/json" }));

  r.post("/sql", async (req, res) => {
    const body = parseBody(req);
    const scope = await pools.forRequest(req);
    try {
      const result = await runSql(scope, config, {
        text: body.sql,
        mode: body.mode,
        schema: body.schema,
        maxRows: config.sqlMaxRows,
        charLimit: config.cellCharLimit,
        onBackend: cancelOnDisconnect(res, scope),
      });
      res.json(result);
    } catch (err) {
      if (err instanceof SqlError) return sendSqlError(res, err);
      throw err;
    }
  });

  r.post("/sql/export", async (req, res) => {
    const body = parseBody(req);
    const format = req.query["format"] ?? "csv";
    if (format !== "csv" && format !== "json") throw new HttpError(400, "format must be csv or json");
    const scope = await pools.forRequest(req);
    let data;
    try {
      data = await exportSql(scope, config, body.sql, body.schema);
    } catch (err) {
      if (err instanceof SqlError) return sendSqlError(res, err);
      throw err;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    res.setHeader("X-Export-Rows", String(data.rows.length));
    res.setHeader("X-Export-Limit-Hit", data.limitHit ? "1" : "0");
    res.setHeader("X-Export-Cut-Cells", String(data.cutCells));
    res.setHeader("Content-Disposition", `attachment; filename="query-${stamp}.${format}"`);
    res.type(format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8");
    res.send(format === "csv" ? toCsv(data) : toJson(data));
  });

  return r;
}
