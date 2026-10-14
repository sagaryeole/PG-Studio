/**
 * Row fetching. Builds one SELECT from catalog metadata only.
 *
 * Every value is returned as Postgres text output (col::text), cut to
 * `cellCharLimit` characters inside the database so huge text/bytea/json
 * values never cross the wire in full. Text is also the format Postgres
 * accepts as input for every type, which is what a future edit endpoint
 * will send back (UPDATE ... SET col = $1::<type>).
 */
import pg from "pg";
import type { TableMeta } from "./catalog.js";

export interface RowPage {
  page: number;
  pageSize: number;
  hasNext: boolean;
  /** Stable order? False when the table has no primary key. */
  orderedByPrimaryKey: boolean;
  rows: (string | null)[][];
  /** [rowIndex, columnIndex] pairs whose value was cut at the char limit. */
  truncated: [number, number][];
}

const q = pg.escapeIdentifier;

export async function fetchRows(
  client: pg.PoolClient,
  table: TableMeta,
  page: number,
  pageSize: number,
  cellCharLimit: number,
): Promise<RowPage> {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("invalid page");
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error("invalid pageSize");
  const charLimit = Math.trunc(cellCharLimit);

  if (table.columns.length === 0) {
    return { page, pageSize, hasNext: false, orderedByPrimaryKey: false, rows: [], truncated: [] };
  }

  // Fetch limit+1 chars so we can tell whether a value was cut.
  const selectList = table.columns
    .map((c, i) => `left(${q(c.name)}::text, ${charLimit + 1}) AS c${i}`)
    .join(", ");

  const from = `${q(table.schema)}.${q(table.name)}`;

  let orderBy = "";
  if (table.primaryKey.length > 0) {
    orderBy = `ORDER BY ${table.primaryKey.map(q).join(", ")}`;
  } else if (table.kind === "table") {
    // Physical order: deterministic within a snapshot, but shifts after updates/VACUUM.
    orderBy = "ORDER BY ctid";
  }

  const sql = `SELECT ${selectList} FROM ${from} ${orderBy} LIMIT $1 OFFSET $2`;
  const offset = (page - 1) * pageSize;

  const res = await client.query({
    text: sql,
    values: [pageSize + 1, offset],
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
    rows,
    truncated,
  };
}
