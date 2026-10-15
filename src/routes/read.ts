import { Router, type Request } from "express";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { checkRole, listTables, resolveTable } from "../catalog.js";
import { FILTER_OPS, parseViewSpec, searchableColumns } from "../query.js";
import { fetchExport, fetchRows, toCsv, toJson } from "../rows.js";
import { HttpError } from "../errors.js";

const MAX_PAGE = 1_000_000;

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
  if (typeof name !== "string" || name.length === 0 || name.length > 63 * 4) {
    throw new HttpError(400, "Invalid table name");
  }
  return name;
}

/** ASCII-only, filesystem-safe file name for Content-Disposition. */
function safeFileName(table: string, ext: string): string {
  const base = table.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "table";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${base}-${stamp}.${ext}`;
}

export function readRoutes(config: Config, db: Db): Router {
  const r = Router();

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

  r.get("/tables", async (_req, res) => {
    const tables = await db.withReadOnly((c) => listTables(c, config.schema));
    res.json({ schema: config.schema, tables });
  });

  r.get("/tables/:name", async (req, res) => {
    const name = tableName(req);
    const page = parsePositiveInt(req.query["page"], "page", 1, MAX_PAGE);
    const pageSize = parsePositiveInt(
      req.query["pageSize"],
      "pageSize",
      config.pageSizeDefault,
      config.pageSizeMax,
    );

    const result = await db.withReadOnly(async (c) => {
      const table = await resolveTable(c, config.schema, name);
      if (!table) return null;
      const spec = parseViewSpec(req.query, table);
      const rows = await fetchRows(c, table, spec, page, pageSize, config.cellCharLimit);
      return {
        table,
        view: spec,
        searchColumns: searchableColumns(table).map((col) => col.name),
        ...rows,
      };
    });

    if (!result) throw new HttpError(404, "Table not found");
    res.json(result);
  });

  r.get("/tables/:name/export", async (req, res) => {
    const name = tableName(req);
    const format = req.query["format"] ?? "csv";
    if (format !== "csv" && format !== "json") throw new HttpError(400, "format must be csv or json");

    const result = await db.withReadOnly(async (c) => {
      const table = await resolveTable(c, config.schema, name);
      if (!table) return null;
      const spec = parseViewSpec(req.query, table);
      const data = await fetchExport(c, table, spec, config.exportMaxRows, config.exportCellCharLimit);
      return { table, data };
    });
    if (!result) throw new HttpError(404, "Table not found");

    const { data } = result;
    const body = format === "csv" ? toCsv(data) : toJson(data);
    res.setHeader("X-Export-Rows", String(data.rows.length));
    res.setHeader("X-Export-Limit-Hit", data.limitHit ? "1" : "0");
    res.setHeader("X-Export-Cut-Cells", String(data.cutCells));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeFileName(result.table.name, format)}"`,
    );
    res.type(format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8");
    res.send(body);
  });

  return r;
}
