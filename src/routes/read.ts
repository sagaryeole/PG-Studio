import { Router } from "express";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { checkRole, listTables, resolveTable } from "../catalog.js";
import { fetchRows } from "../rows.js";
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
      // Edit seam: the UI reads this to decide whether to show edit affordances.
      capabilities: { edit: false },
    });
  });

  r.get("/tables", async (_req, res) => {
    const tables = await db.withReadOnly((c) => listTables(c, config.schema));
    res.json({ schema: config.schema, tables });
  });

  r.get("/tables/:name", async (req, res) => {
    const name = req.params.name;
    if (typeof name !== "string" || name.length === 0 || name.length > 63 * 4) {
      throw new HttpError(400, "Invalid table name");
    }
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
      const rows = await fetchRows(c, table, page, pageSize, config.cellCharLimit);
      return { table, ...rows };
    });

    if (!result) throw new HttpError(404, "Table not found");
    res.json(result);
  });

  return r;
}
