/**
 * Catalog lookups. User input (a table name) is ONLY ever used as a bind
 * parameter here. The identifiers we later splice into SQL come from the
 * catalog rows returned by these queries, never from the request.
 */
import type pg from "pg";

export interface TableSummary {
  name: string;
  kind: "table" | "partitioned";
  /** Planner estimate; null when the table has never been analyzed. */
  estimatedRows: number | null;
}

export interface ColumnMeta {
  name: string;
  /** Full SQL type, e.g. "character varying(255)", "timestamp with time zone". */
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  hasDefault: boolean;
  /** GENERATED ALWAYS AS (...) STORED — never editable. */
  isGenerated: boolean;
  /** GENERATED ... AS IDENTITY. */
  isIdentity: boolean;
  /**
   * Whether the CURRENT role may UPDATE this column. With the recommended
   * read-only role this is always false. Edit mode (future) will require it.
   */
  canUpdate: boolean;
}

export interface TableMeta {
  oid: string;
  schema: string;
  name: string;
  kind: "table" | "partitioned";
  estimatedRows: number | null;
  columns: ColumnMeta[];
  /** Primary-key column names in key order. Empty if the table has no PK. */
  primaryKey: string[];
}

export interface RoleCheck {
  role: string;
  isSuperuser: boolean;
  /** Tables in the schema this role can INSERT/UPDATE/DELETE/TRUNCATE. */
  writableTables: number;
}

const ROLE_SQL = `
  SELECT current_user::text AS role,
         r.rolsuper         AS is_superuser,
         (SELECT count(*)::int
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1
             AND c.relkind IN ('r', 'p')
             AND (has_table_privilege(c.oid, 'INSERT')
               OR has_table_privilege(c.oid, 'UPDATE')
               OR has_table_privilege(c.oid, 'DELETE')
               OR has_table_privilege(c.oid, 'TRUNCATE'))) AS writable_tables
    FROM pg_catalog.pg_roles r
   WHERE r.rolname = current_user`;

/** Report whether the connected role could modify data if the app had a bug. */
export async function checkRole(client: pg.PoolClient, schema: string): Promise<RoleCheck> {
  const res = await client.query<{ role: string; is_superuser: boolean; writable_tables: number }>(
    ROLE_SQL,
    [schema],
  );
  const r = res.rows[0];
  return {
    role: r?.role ?? "unknown",
    isSuperuser: r?.is_superuser ?? false,
    writableTables: r?.writable_tables ?? 0,
  };
}

function kindOf(relkind: string): "table" | "partitioned" {
  return relkind === "p" ? "partitioned" : "table";
}

function estimate(reltuples: string | number | null): number | null {
  if (reltuples === null) return null;
  const n = Number(reltuples);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

const TABLES_SQL = `
  SELECT c.relname        AS name,
         c.relkind        AS relkind,
         c.reltuples      AS reltuples
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1
     AND c.relkind IN ('r', 'p')
     AND NOT c.relispartition
     AND has_table_privilege(c.oid, 'SELECT')
   ORDER BY c.relname`;

export async function listTables(client: pg.PoolClient, schema: string): Promise<TableSummary[]> {
  const res = await client.query<{ name: string; relkind: string; reltuples: number | null }>(
    TABLES_SQL,
    [schema],
  );
  return res.rows.map((r) => ({
    name: r.name,
    kind: kindOf(r.relkind),
    estimatedRows: estimate(r.reltuples),
  }));
}

const RESOLVE_SQL = `
  SELECT c.oid::text      AS oid,
         n.nspname        AS schema,
         c.relname        AS name,
         c.relkind        AS relkind,
         c.reltuples      AS reltuples
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1
     AND c.relname = $2
     AND c.relkind IN ('r', 'p')
     AND NOT c.relispartition
     AND has_table_privilege(c.oid, 'SELECT')`;

const COLUMNS_SQL = `
  SELECT a.attname                                   AS name,
         pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
         NOT a.attnotnull                            AS nullable,
         a.atthasdef                                 AS has_default,
         a.attgenerated <> ''                        AS is_generated,
         a.attidentity  <> ''                        AS is_identity,
         has_column_privilege(a.attrelid, a.attnum, 'UPDATE') AS can_update
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = $1::oid
     AND a.attnum > 0
     AND NOT a.attisdropped
     AND has_column_privilege(a.attrelid, a.attnum, 'SELECT')
   ORDER BY a.attnum`;

const PK_SQL = `
  SELECT a.attname AS name
    FROM pg_catalog.pg_index i
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = i.indrelid AND a.attnum = k.attnum
   WHERE i.indrelid = $1::oid
     AND i.indisprimary
   ORDER BY k.ord`;

/**
 * Resolve a user-supplied table name to catalog metadata.
 * Returns null if the table does not exist in the schema or is not readable.
 */
export async function resolveTable(
  client: pg.PoolClient,
  schema: string,
  requestedName: string,
): Promise<TableMeta | null> {
  const found = await client.query<{
    oid: string;
    schema: string;
    name: string;
    relkind: string;
    reltuples: number | null;
  }>(RESOLVE_SQL, [schema, requestedName]);

  const t = found.rows[0];
  if (!t) return null;

  const [cols, pk] = await Promise.all([
    client.query<{
      name: string;
      type: string;
      nullable: boolean;
      has_default: boolean;
      is_generated: boolean;
      is_identity: boolean;
      can_update: boolean;
    }>(COLUMNS_SQL, [t.oid]),
    client.query<{ name: string }>(PK_SQL, [t.oid]),
  ]);

  const primaryKey = pk.rows.map((r) => r.name);
  const pkSet = new Set(primaryKey);

  return {
    oid: t.oid,
    schema: t.schema,
    name: t.name,
    kind: kindOf(t.relkind),
    estimatedRows: estimate(t.reltuples),
    primaryKey,
    columns: cols.rows.map((c) => ({
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      isPrimaryKey: pkSet.has(c.name),
      hasDefault: c.has_default,
      isGenerated: c.is_generated,
      isIdentity: c.is_identity,
      canUpdate: c.can_update,
    })),
  };
}
