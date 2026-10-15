/**
 * View spec: sort, filters and search for one table.
 *
 * The browser never sends SQL. It sends column NAMES and an operator from a
 * fixed list. Names are resolved against the catalog (TableMeta), and only
 * catalog names are quoted into SQL. Every value is a bind parameter.
 */
import pg from "pg";
import { hasCtid, type ColumnMeta, type TableMeta } from "./catalog.js";
import { HttpError } from "./errors.js";

const q = pg.escapeIdentifier;

export const FILTER_OPS = [
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "not_contains",
  "starts",
  "ends",
  "null",
  "not_null",
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

const VALUELESS: ReadonlySet<FilterOp> = new Set(["null", "not_null"]);
const MAX_FILTERS = 10;
const MAX_VALUE_LEN = 1000;
const MAX_SEARCH_LEN = 200;

export interface Filter {
  column: string;
  op: FilterOp;
  value?: string;
}

export interface ViewSpec {
  sort: { column: string; dir: "asc" | "desc" } | null;
  filters: Filter[];
  search: string;
}

function str(raw: unknown, name: string): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string") throw new HttpError(400, `${name} must be given once`);
  return raw;
}

function column(table: TableMeta, name: string): ColumnMeta {
  const col = table.columns.find((c) => c.name === name);
  if (!col) throw new HttpError(400, `Unknown column: ${name.slice(0, 80)}`);
  return col;
}

/** Parse and validate ?sort=&dir=&filters=&q= against the table's catalog metadata. */
export function parseViewSpec(query: Record<string, unknown>, table: TableMeta): ViewSpec {
  // Sort
  let sort: ViewSpec["sort"] = null;
  const sortCol = str(query["sort"], "sort");
  if (sortCol !== undefined) {
    const dirRaw = str(query["dir"], "dir") ?? "asc";
    if (dirRaw !== "asc" && dirRaw !== "desc") throw new HttpError(400, "dir must be asc or desc");
    sort = { column: column(table, sortCol).name, dir: dirRaw };
  }

  // Filters: JSON array of {c, op, v?}
  const filters: Filter[] = [];
  const rawFilters = str(query["filters"], "filters");
  if (rawFilters !== undefined) {
    if (rawFilters.length > 20_000) throw new HttpError(400, "filters too long");
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawFilters);
    } catch {
      throw new HttpError(400, "filters must be JSON");
    }
    if (!Array.isArray(parsed)) throw new HttpError(400, "filters must be an array");
    if (parsed.length > MAX_FILTERS) throw new HttpError(400, `At most ${MAX_FILTERS} filters`);
    for (const f of parsed as unknown[]) {
      if (typeof f !== "object" || f === null) throw new HttpError(400, "Invalid filter");
      const { c, op, v } = f as { c?: unknown; op?: unknown; v?: unknown };
      if (typeof c !== "string") throw new HttpError(400, "Filter column missing");
      if (typeof op !== "string" || !(FILTER_OPS as readonly string[]).includes(op)) {
        throw new HttpError(400, "Unknown filter operator");
      }
      const fop = op as FilterOp;
      const col = column(table, c);
      if (VALUELESS.has(fop)) {
        filters.push({ column: col.name, op: fop });
      } else {
        if (typeof v !== "string") throw new HttpError(400, `Filter on ${col.name} needs a value`);
        if (v.length > MAX_VALUE_LEN) throw new HttpError(400, "Filter value too long");
        filters.push({ column: col.name, op: fop, value: v });
      }
    }
  }

  // Search
  const search = (str(query["q"], "q") ?? "").trim();
  if (search.length > MAX_SEARCH_LEN) throw new HttpError(400, "Search text too long");

  return { sort, filters, search };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Columns the free-text search looks at: string and enum types. */
export function searchableColumns(table: TableMeta): ColumnMeta[] {
  return table.columns.filter((c) => c.category === "S" || c.category === "E");
}

/**
 * Build the WHERE clause. Values are appended to `params`; placeholders refer
 * to their positions. Comparison operators use untyped parameters, so
 * Postgres infers each one's type from the column it is compared with.
 */
export function buildWhere(table: TableMeta, spec: ViewSpec, params: unknown[]): string {
  const parts: string[] = [];
  const p = (v: unknown): string => `$${params.push(v)}`;

  for (const f of spec.filters) {
    const col = q(f.column);
    const v = f.value ?? "";
    switch (f.op) {
      case "eq":
        parts.push(`${col} = ${p(v)}`);
        break;
      case "neq":
        parts.push(`${col} IS DISTINCT FROM ${p(v)}`);
        break;
      case "lt":
        parts.push(`${col} < ${p(v)}`);
        break;
      case "lte":
        parts.push(`${col} <= ${p(v)}`);
        break;
      case "gt":
        parts.push(`${col} > ${p(v)}`);
        break;
      case "gte":
        parts.push(`${col} >= ${p(v)}`);
        break;
      case "contains":
        parts.push(`${col}::text ILIKE ${p(`%${escapeLike(v)}%`)} ESCAPE '\\'`);
        break;
      case "not_contains":
        parts.push(`(${col} IS NULL OR ${col}::text NOT ILIKE ${p(`%${escapeLike(v)}%`)} ESCAPE '\\')`);
        break;
      case "starts":
        parts.push(`${col}::text ILIKE ${p(`${escapeLike(v)}%`)} ESCAPE '\\'`);
        break;
      case "ends":
        parts.push(`${col}::text ILIKE ${p(`%${escapeLike(v)}`)} ESCAPE '\\'`);
        break;
      case "null":
        parts.push(`${col} IS NULL`);
        break;
      case "not_null":
        parts.push(`${col} IS NOT NULL`);
        break;
    }
  }

  if (spec.search) {
    const cols = searchableColumns(table);
    if (cols.length === 0) throw new HttpError(400, "This table has no text columns to search");
    const ph = p(`%${escapeLike(spec.search)}%`);
    parts.push(`(${cols.map((c) => `${q(c.name)}::text ILIKE ${ph} ESCAPE '\\'`).join(" OR ")})`);
  }

  return parts.length ? `WHERE ${parts.join(" AND ")}` : "";
}

/** ORDER BY: requested sort first, then the primary key (or ctid) so paging is stable. */
export function buildOrderBy(table: TableMeta, spec: ViewSpec): string {
  const terms: string[] = [];
  if (spec.sort) {
    terms.push(`${q(spec.sort.column)} ${spec.sort.dir === "desc" ? "DESC NULLS LAST" : "ASC NULLS LAST"}`);
  }
  const tiebreak = table.primaryKey.filter((k) => k !== spec.sort?.column);
  if (table.primaryKey.length > 0) {
    terms.push(...tiebreak.map(q));
  } else if (hasCtid(table.kind)) {
    terms.push("ctid");
  }
  return terms.length ? `ORDER BY ${terms.join(", ")}` : "";
}

/** True when the view has any filter or search applied. */
export function isFiltered(spec: ViewSpec): boolean {
  return spec.filters.length > 0 || spec.search.length > 0;
}
