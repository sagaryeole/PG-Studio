import { Router, type Request } from "express";
import type pg from "pg";
import type { Config } from "../config.js";
import type { Pools, Scope } from "../pools.js";
import { checkRole, listSchemas, listTables, resolveTable, schemaUsable, type TableMeta } from "../catalog.js";
import { countRows, fetchDetails } from "../details.js";
import { FILTER_OPS, parseViewSpec, searchableColumns } from "../query.js";
import { buildDisplaySql, decodeCursor, fetchExport, fetchRows, toCsv, toJson, type Cursor } from "../rows.js";
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

/** The schema a connection opens on: its own setting, else PG_SCHEMA. */
export function preferredSchema(scope: Scope, config: Config): string {
  return scope.connection.schema ?? config.schema;
}

/** ?schema= or the scope's default. Only ever used as a bind parameter. */
function schemaParam(req: Request, fallback: string): string {
  const raw = req.query["schema"];
  if (raw === undefined || raw === "") return fallback;
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

export function readRoutes(config: Config, pools: Pools): Router {
  const r = Router();

  /** Resolve connection, database, schema + table inside a read-only transaction, or 404. */
  async function withTable<T>(
    req: Request,
    fn: (c: pg.PoolClient, table: TableMeta) => Promise<T>,
  ): Promise<T> {
    const scope = await pools.forRequest(req);
    const schema = schemaParam(req, preferredSchema(scope, config));
    const name = tableName(req);
    const result = await scope.db.withReadOnly(async (c) => {
      const table = await resolveTable(c, schema, name);
      if (!table) return { found: false as const };
      return { found: true as const, value: await fn(c, table) };
    });
    if (!result.found) throw new HttpError(404, "Table not found");
    return result.value;
  }

  r.get("/meta", async (req, res) => {
    const scope = await pools.forRequest(req);
    const preferred = preferredSchema(scope, config);
    const { schema, role } = await scope.db.withReadOnly(async (c) => {
      // Another database may not have the configured schema; open the first readable one instead.
      let s = preferred;
      if (!(await schemaUsable(c, s))) {
        const all = await listSchemas(c);
        s = all.find((x) => x.name === "public")?.name ?? all[0]?.name ?? preferred;
      }
      return { schema: s, role: await checkRole(c, s) };
    });
    res.json({
      connection: scope.connection.id,
      database: scope.database,
      schema,
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

  r.get("/schemas", async (req, res) => {
    const scope = await pools.forRequest(req);
    const schemas = await scope.db.withReadOnly((c) => listSchemas(c));
    res.json({ default: preferredSchema(scope, config), schemas });
  });

  r.get("/tables", async (req, res) => {
    const scope = await pools.forRequest(req);
    const schema = schemaParam(req, preferredSchema(scope, config));
    const result = await scope.db.withReadOnly(async (c) => {
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

  // Display only: the SELECT for page 1 of the view. Built from the same validated params, never executed.
  r.get("/tables/:name/sql", async (req, res) => {
    const page = parsePositiveInt(req.query["page"], "page", 1, MAX_PAGE);
    const pageSize = parsePositiveInt(req.query["pageSize"], "pageSize", config.pageSizeDefault, config.pageSizeMax);
    const sql = await withTable(req, async (_c, table) =>
      buildDisplaySql(table, parseViewSpec(req.query, table), page, pageSize),
    );
    res.json({ sql });
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
