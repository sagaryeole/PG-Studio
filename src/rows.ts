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
import type { TableMeta } from "./catalog.js";
import { buildOrderBy, buildWhere, isFiltered, type ViewSpec } from "./query.js";

export interface RowPage {
  page: number;
  pageSize: number;
  hasNext: boolean;
  /** Stable order? False when the table has no primary key. */
  orderedByPrimaryKey: boolean;
  filtered: boolean;
  rows: (string | null)[][];
  /** [rowIndex, columnIndex] pairs whose value was cut at the char limit. */
  truncated: [number, number][];
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

export async function fetchRows(
  client: pg.PoolClient,
  table: TableMeta,
  spec: ViewSpec,
  page: number,
  pageSize: number,
  cellCharLimit: number,
): Promise<RowPage> {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("invalid page");
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error("invalid pageSize");
  const charLimit = Math.trunc(cellCharLimit);
  const filtered = isFiltered(spec);

  if (table.columns.length === 0) {
    return { page, pageSize, hasNext: false, orderedByPrimaryKey: false, filtered, rows: [], truncated: [] };
  }

  const params: unknown[] = [];
  const base = buildSelect(table, spec, charLimit, params);
  const limitPh = `$${params.push(pageSize + 1)}`;
  const offsetPh = `$${params.push((page - 1) * pageSize)}`;

  const res = await client.query({
    text: `${base} LIMIT ${limitPh} OFFSET ${offsetPh}`,
    values: params,
    rowMode: "array",
  });

  const raw = res.rows as (string | null)[][];
  const hasNext = raw.length > pageSize;
  const pageRows = hasNext ? raw.slice(0, pageSize) : raw;

  const truncated: [number, number][] = [];
  const rows = pageRows.map((row, r) =>
    row.map((v, c) => {
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
    hasNext,
    orderedByPrimaryKey: table.primaryKey.length > 0,
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
