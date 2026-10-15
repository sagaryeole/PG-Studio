/**
 * Row fetching. Builds one SELECT from catalog metadata plus a validated
 * ViewSpec (sort, filters, search).
 *
 * Every value is returned as Postgres text output (col::text), cut to a
 * character limit inside the database so huge text/bytea/json values never
 * cross the wire in full. Text is also the format Postgres accepts as input
 * for every type, which is what a future edit endpoint will send back.
 */
import pg from "pg";
import { hasCtid, type TableMeta } from "./catalog.js";
import { HttpError } from "./errors.js";
import { buildOrderBy, buildWhere, isFiltered, type ViewSpec } from "./query.js";

export interface RowPage {
  /** Page number as the client counts it; only used for display in keyset mode. */
  page: number;
  pageSize: number;
  /**
   * "keyset": pages are fetched relative to the last/first row's key (fast at any depth).
   * "offset": LIMIT/OFFSET (used when a custom sort is active or there is no usable key).
   */
  paging: "keyset" | "offset";
  hasNext: boolean;
  hasPrev: boolean;
  /** Opaque cursors for keyset paging: pass as ?after= / ?before=. */
  nextCursor: string | null;
  prevCursor: string | null;
  /** Stable order? False when there is no primary key. */
  orderedByPrimaryKey: boolean;
  filtered: boolean;
  rows: (string | null)[][];
  /** [rowIndex, columnIndex] pairs whose value was cut at the char limit. */
  truncated: [number, number][];
}

export interface Cursor {
  dir: "after" | "before";
  values: string[];
}

const q = pg.escapeIdentifier;

function selectList(table: TableMeta, charLimit: number): string {
  return table.columns.map((c, i) => `left(${q(c.name)}::text, ${charLimit + 1}) AS c${i}`).join(", ");
}

function buildSelect(
  table: TableMeta,
  spec: ViewSpec,
  charLimit: number,
  params: unknown[],
): string {
  const where = buildWhere(table, spec, params);
  const orderBy = buildOrderBy(table, spec);
  return `SELECT ${selectList(table, charLimit)} FROM ${q(table.schema)}.${q(table.name)} ${where} ${orderBy}`;
}

/**
 * Key expressions for keyset paging, or null when it can't be used.
 * Only the default order qualifies: a custom sort falls back to OFFSET,
 * because the sort column is usually unindexed (so keyset wouldn't help)
 * and NULLs and mixed directions make the cursor condition fragile.
 */
export function keysetKeys(table: TableMeta, spec: ViewSpec): string[] | null {
  if (spec.sort) return null;
  if (table.primaryKey.length > 0) return table.primaryKey.map(q);
  if (hasCtid(table.kind)) return ["ctid"];
  return null;
}

export function encodeCursor(values: string[]): string {
  return Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): string[] {
  if (raw.length > 8000) throw new HttpError(400, "Cursor too long");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid cursor");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > 32 ||
    !parsed.every((v) => typeof v === "string" && v.length <= 2000)
  ) {
    throw new HttpError(400, "Invalid cursor");
  }
  return parsed as string[];
}

export async function fetchRows(
  client: pg.PoolClient,
  table: TableMeta,
  spec: ViewSpec,
  opts: { page: number; pageSize: number; cursor: Cursor | null },
  cellCharLimit: number,
): Promise<RowPage> {
  const { page, pageSize, cursor } = opts;
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("invalid page");
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error("invalid pageSize");
  const charLimit = Math.trunc(cellCharLimit);
  const filtered = isFiltered(spec);
  const keys = keysetKeys(table, spec);
  const orderedByPrimaryKey = table.primaryKey.length > 0;

  if (cursor && !keys) throw new HttpError(400, "Cursor paging isn't available for this view");
  if (cursor && keys && cursor.values.length !== keys.length) throw new HttpError(400, "Invalid cursor");

  if (table.columns.length === 0) {
    return {
      page, pageSize, paging: keys ? "keyset" : "offset", hasNext: false, hasPrev: false,
      nextCursor: null, prevCursor: null, orderedByPrimaryKey, filtered, rows: [], truncated: [],
    };
  }

  const params: unknown[] = [];
  const nCols = table.columns.length;
  let sql: string;

  if (keys) {
    // Keyset: SELECT data columns + full key values, WHERE (keys) > (cursor), ORDER BY keys.
    const keyCols = keys.map((k, i) => `${k}::text AS k${i}`).join(", ");
    let where = buildWhere(table, spec, params);
    if (cursor) {
      const phs = cursor.values.map((v) => `$${params.push(v)}`);
      const cond = `(${keys.join(", ")}) ${cursor.dir === "after" ? ">" : "<"} (${phs.join(", ")})`;
      where = where ? `${where} AND ${cond}` : `WHERE ${cond}`;
    }
    const dir = cursor?.dir === "before" ? "DESC" : "ASC";
    const orderBy = `ORDER BY ${keys.map((k) => `${k} ${dir}`).join(", ")}`;
    const limitPh = `$${params.push(pageSize + 1)}`;
    sql = `SELECT ${selectList(table, charLimit)}, ${keyCols} FROM ${q(table.schema)}.${q(table.name)} ${where} ${orderBy} LIMIT ${limitPh}`;
  } else {
    const base = buildSelect(table, spec, charLimit, params);
    const limitPh = `$${params.push(pageSize + 1)}`;
    const offsetPh = `$${params.push((page - 1) * pageSize)}`;
    sql = `${base} LIMIT ${limitPh} OFFSET ${offsetPh}`;
  }

  const res = await client.query({ text: sql, values: params, rowMode: "array" });
  const raw = res.rows as (string | null)[][];
  const more = raw.length > pageSize;
  let pageRows = more ? raw.slice(0, pageSize) : raw;

  // Paging backwards reached the start: show a proper full first page instead.
  if (cursor?.dir === "before" && !more) {
    return fetchRows(client, table, spec, { page: 1, pageSize, cursor: null }, cellCharLimit);
  }
  if (cursor?.dir === "before") pageRows = pageRows.reverse();

  let hasNext: boolean;
  let hasPrev: boolean;
  if (!keys) {
    hasNext = more;
    hasPrev = page > 1;
  } else if (!cursor) {
    hasNext = more;
    hasPrev = false;
  } else if (cursor.dir === "after") {
    hasNext = more;
    hasPrev = true;
  } else {
    hasNext = true;
    hasPrev = true;
  }

  const keyOf = (row: (string | null)[]): string => encodeCursor(row.slice(nCols).map((v) => v ?? ""));
  const firstRow = pageRows[0];
  const lastRow = pageRows[pageRows.length - 1];

  const truncated: [number, number][] = [];
  const rows = pageRows.map((row, r) =>
    row.slice(0, nCols).map((v, c) => {
      if (v !== null && v.length > charLimit) {
        truncated.push([r, c]);
        return v.slice(0, charLimit);
      }
      return v;
    }),
  );

  return {
    page,
    pageSize,
    paging: keys ? "keyset" : "offset",
    hasNext,
    hasPrev,
    nextCursor: keys && lastRow ? keyOf(lastRow) : null,
    prevCursor: keys && firstRow ? keyOf(firstRow) : null,
    orderedByPrimaryKey,
    filtered,
    rows,
    truncated,
  };
}

export interface ExportResult {
  columns: string[];
  rows: (string | null)[][];
  /** True when more rows matched than the export limit allowed. */
  limitHit: boolean;
  /** Number of cells cut at the export character limit. */
  cutCells: number;
}

/** Fetch up to `maxRows` rows of the current view for export. */
export async function fetchExport(
  client: pg.PoolClient,
  table: TableMeta,
  spec: ViewSpec,
  maxRows: number,
  cellCharLimit: number,
): Promise<ExportResult> {
  const columns = table.columns.map((c) => c.name);
  if (columns.length === 0) return { columns, rows: [], limitHit: false, cutCells: 0 };

  const charLimit = Math.trunc(cellCharLimit);
  const params: unknown[] = [];
  const base = buildSelect(table, spec, charLimit, params);
  const limitPh = `$${params.push(maxRows + 1)}`;

  const res = await client.query({ text: `${base} LIMIT ${limitPh}`, values: params, rowMode: "array" });
  const raw = res.rows as (string | null)[][];
  const limitHit = raw.length > maxRows;

  let cutCells = 0;
  const rows = (limitHit ? raw.slice(0, maxRows) : raw).map((row) =>
    row.map((v) => {
      if (v !== null && v.length > charLimit) {
        cutCells++;
        return v.slice(0, charLimit);
      }
      return v;
    }),
  );
  return { columns, rows, limitHit, cutCells };
}

// ---- Serialisers -------------------------------------------------------

/**
 * Spreadsheet apps treat cells starting with = + - @ (or tab/CR) as formulas.
 * Data from a web app can contain those on purpose, so prefix them with a
 * quote, unless the value is a plain number such as -5 or +3.2.
 */
function neutraliseFormula(v: string): string {
  if (/^[=+\-@\t\r]/.test(v) && !/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) return `'${v}`;
  return v;
}

function csvCell(v: string | null): string {
  if (v === null) return "";
  const s = neutraliseFormula(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(result: ExportResult): string {
  const lines = [result.columns.map(csvCell).join(",")];
  for (const row of result.rows) lines.push(row.map(csvCell).join(","));
  // BOM so Excel opens UTF-8 correctly.
  return `﻿${lines.join("\r\n")}\r\n`;
}

export function toJson(result: ExportResult): string {
  const objects = result.rows.map((row) => {
    const o: Record<string, string | null> = {};
    result.columns.forEach((c, i) => {
      o[c] = row[i] ?? null;
    });
    return o;
  });
  return JSON.stringify(objects, null, 2);
}
