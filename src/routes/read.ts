import { Router, type Request } from "express";
import type pg from "pg";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { checkRole, listSchemas, listTables, resolveTable, schemaUsable, type TableMeta } from "../catalog.js";
import { countRows, fetchDetails } from "../details.js";
import { FILTER_OPS, parseViewSpec, searchableColumns } from "../query.js";
import { decodeCursor, fetchExport, fetchRows, toCsv, toJson, type Cursor } from "../rows.js";
import { HttpError } from "../errors.js";

const MAX_PAGE = 1_000_000;
const MAX_IDENT = 63 * 4; // 63 bytes; up to 4 bytes per UTF-8 char

function parsePositiveInt(raw: unknown, name: string, fallback: number, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (typeof raw !== "string" || !/^\d{1,9}$/.test(raw)) {
    throw new HttpError(400, `${name} must be a positive integer`);
  }
  const n = Number(raw);
  if (n < 1 || n > max) throw new HttpError(400, `${name} must be between 1 and ${max}`);
  return n;
}

function tableName(req: Request): string {
  const name = req.params["name"];
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_IDENT) {
    throw new HttpError(400, "Invalid table name");
  }
  return name;
}

/** ?schema= or the configured default. Only ever used as a bind parameter. */
function schemaParam(req: Request, config: Config): string {
  const raw = req.query["schema"];
  if (raw === undefined || raw === "") return config.schema;
  if (typeof raw !== "string" || raw.length > MAX_IDENT) throw new HttpError(400, "Invalid schema");
  return raw;
}

function cursorParam(req: Request): Cursor | null {
  const after = req.query["after"];
  const before = req.query["before"];
  if (after !== undefined && before !== undefined) throw new HttpError(400, "Use after or before, not both");
  const raw = after ?? before;
  if (raw === undefined || raw === "") return null;
  if (typeof raw !== "string") throw new HttpError(400, "Invalid cursor");
  return { dir: after !== undefined ? "after" : "before", values: decodeCursor(raw) };
}

/** ASCII-only, filesystem-safe file name for Content-Disposition. */
function safeFileName(table: string, ext: string): string {
  const base = table.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "table";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${base}-${stamp}.${ext}`;
}

export function readRoutes(config: Config, db: Db): Router {
  const r = Router();

  /** Resolve schema + table inside a read-only transaction, or 404. */
  async function withTable<T>(
    req: Request,
    fn: (c: pg.PoolClient, table: TableMeta) => Promise<T>,
  ): Promise<T> {
    const schema = schemaParam(req, config);
    const name = tableName(req);
    const result = await db.withReadOnly(async (c) => {
      const table = await resolveTable(c, schema, name);
      if (!table) return { found: false as const };
      return { found: true as const, value: await fn(c, table) };
    });
    if (!result.found) throw new HttpError(404, "Table not found");
    return result.value;
  }

  r.get("/meta", async (_req, res) => {
    const role = await db.withReadOnly((c) => checkRole(c, config.schema));
    res.json({
      schema: config.schema,
      role: {
        name: role.role,
        canWrite: role.isSuperuser || role.writableTables > 0,
      },
      pageSizeDefault: config.pageSizeDefault,
      pageSizeMax: config.pageSizeMax,
      cellCharLimit: config.cellCharLimit,
      exportMaxRows: config.exportMaxRows,
      filterOps: FILTER_OPS,
      // Edit seam: the UI reads this to decide whether to show edit affordances.
      capabilities: { edit: false },
    });
  });

  r.get("/schemas", async (_req, res) => {
    const schemas = await db.withReadOnly((c) => listSchemas(c));
    res.json({ default: config.schema, schemas });
  });

  r.get("/tables", async (req, res) => {
    const schema = schemaParam(req, config);
    const result = await db.withReadOnly(async (c) => {
      if (!(await schemaUsable(c, schema))) return null;
      return listTables(c, schema);
    });
    if (!result) throw new HttpError(404, "Schema not found");
    res.json({ schema, tables: result });
  });

  r.get("/tables/:name", async (req, res) => {
    const page = parsePositiveInt(req.query["page"], "page", 1, MAX_PAGE);
    const pageSize = parsePositiveInt(req.query["pageSize"], "pageSize", config.pageSizeDefault, config.pageSizeMax);
    const cursor = cursorParam(req);

    const result = await withTable(req, async (c, table) => {
      const spec = parseViewSpec(req.query, table);
      const rows = await fetchRows(c, table, spec, { page, pageSize, cursor }, config.cellCharLimit);
      return {
        table,
        view: spec,
        searchColumns: searchableColumns(table).map((col) => col.name),
        ...rows,
      };
    });
    res.json(result);
  });

  r.get("/tables/:name/details", async (req, res) => {
    res.json(await withTable(req, (c, table) => fetchDetails(c, table)));
  });

  r.get("/tables/:name/count", async (req, res) => {
    const result = await withTable(req, (c, table) => countRows(c, table, parseViewSpec(req.query, table)));
    res.json(result);
  });

  r.get("/tables/:name/export", async (req, res) => {
    const format = req.query["format"] ?? "csv";
    if (format !== "csv" && format !== "json") throw new HttpError(400, "format must be csv or json");

    const { table, data } = await withTable(req, async (c, t) => {
      const spec = parseViewSpec(req.query, t);
      return { table: t, data: await fetchExport(c, t, spec, config.exportMaxRows, config.exportCellCharLimit) };
    });

    const body = format === "csv" ? toCsv(data) : toJson(data);
    res.setHeader("X-Export-Rows", String(data.rows.length));
    res.setHeader("X-Export-Limit-Hit", data.limitHit ? "1" : "0");
    res.setHeader("X-Export-Cut-Cells", String(data.cutCells));
    res.setHeader("Content-Disposition", `attachment; filename="${safeFileName(table.name, format)}"`);
    res.type(format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8");
    res.send(body);
  });

  return r;
}
