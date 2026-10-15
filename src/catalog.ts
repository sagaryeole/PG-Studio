/**
 * Catalog lookups. User input (a table name) is ONLY ever used as a bind
 * parameter here. The identifiers we later splice into SQL come from the
 * catalog rows returned by these queries, never from the request.
 */
import type pg from "pg";

export type RelKind = "table" | "partitioned" | "view" | "matview";

export interface TableSummary {
  name: string;
  kind: RelKind;
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
  /** pg_type.typcategory: S=string, N=numeric, D=date/time, B=boolean, U=user (json, uuid…), E=enum, A=array … */
  category: string;
}

/** A foreign key, seen from either side. Column lists are in key order and pair up by index. */
export interface ForeignKey {
  name: string;
  /** The table holding the foreign key columns. */
  fromSchema: string;
  fromTable: string;
  fromColumns: string[];
  /** The referenced table. */
  toSchema: string;
  toTable: string;
  toColumns: string[];
  /** Whether the current role can SELECT the other table, i.e. navigation is possible. */
  navigable: boolean;
}

export interface TableMeta {
  oid: string;
  schema: string;
  name: string;
  kind: RelKind;
  estimatedRows: number | null;
  columns: ColumnMeta[];
  /** Primary-key column names in key order. Empty if the table has no PK. */
  primaryKey: string[];
  /** FKs on this table pointing elsewhere. */
  foreignKeys: ForeignKey[];
  /** FKs on other tables pointing at this one. */
  referencedBy: ForeignKey[];
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

/** Relation kinds the viewer can browse: tables, partitioned tables, views, materialized views. */
const BROWSABLE = "('r', 'p', 'v', 'm')";

function kindOf(relkind: string): RelKind {
  switch (relkind) {
    case "p":
      return "partitioned";
    case "v":
      return "view";
    case "m":
      return "matview";
    default:
      return "table";
  }
}

/** Tables and materialized views have a physical row id (ctid); views and partitioned parents don't. */
export function hasCtid(kind: RelKind): boolean {
  return kind === "table" || kind === "matview";
}

function estimate(reltuples: string | number | null, relkind?: string): number | null {
  if (reltuples === null || relkind === "v") return null;
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
     AND c.relkind IN ${BROWSABLE}
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
    estimatedRows: estimate(r.reltuples, r.relkind),
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
     AND c.relkind IN ${BROWSABLE}
     AND NOT c.relispartition
     AND has_table_privilege(c.oid, 'SELECT')`;

const COLUMNS_SQL = `
  SELECT a.attname                                   AS name,
         pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
         NOT a.attnotnull                            AS nullable,
         a.atthasdef                                 AS has_default,
         a.attgenerated <> ''                        AS is_generated,
         a.attidentity  <> ''                        AS is_identity,
         has_column_privilege(a.attrelid, a.attnum, 'UPDATE') AS can_update,
         t.typcategory::text                         AS category
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
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

// Column-name arrays for a constraint, in key order. Cast to text[] so node-pg parses them.
const FK_COLS = (keyCol: "conkey" | "confkey", relCol: "conrelid" | "confrelid") => `
  ARRAY(SELECT a.attname
          FROM unnest(con.${keyCol}) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_catalog.pg_attribute a ON a.attrelid = con.${relCol} AND a.attnum = k.attnum
         ORDER BY k.ord)::text[]`;

// conparentid = 0 skips the per-partition clones of a constraint on a partitioned table.
const FKS_SQL = `
  SELECT con.conname::text                 AS name,
         fn.nspname::text                  AS from_schema,
         fc.relname::text                  AS from_table,
         ${FK_COLS("conkey", "conrelid")}  AS from_columns,
         tn.nspname::text                  AS to_schema,
         tc.relname::text                  AS to_table,
         ${FK_COLS("confkey", "confrelid")} AS to_columns,
         CASE WHEN con.conrelid = $1::oid
              THEN has_table_privilege(con.confrelid, 'SELECT')
              ELSE has_table_privilege(con.conrelid, 'SELECT') END AS navigable,
         con.conrelid = $1::oid            AS outgoing
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class fc     ON fc.oid = con.conrelid
    JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
    JOIN pg_catalog.pg_class tc     ON tc.oid = con.confrelid
    JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
   WHERE con.contype = 'f'
     AND con.conparentid = 0
     AND (con.conrelid = $1::oid OR con.confrelid = $1::oid)
   ORDER BY con.conname`;

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

  const [cols, pk, fks] = await Promise.all([
    client.query<{
      name: string;
      type: string;
      nullable: boolean;
      has_default: boolean;
      is_generated: boolean;
      is_identity: boolean;
      can_update: boolean;
      category: string;
    }>(COLUMNS_SQL, [t.oid]),
    client.query<{ name: string }>(PK_SQL, [t.oid]),
    client.query<{
      name: string;
      from_schema: string;
      from_table: string;
      from_columns: string[];
      to_schema: string;
      to_table: string;
      to_columns: string[];
      navigable: boolean;
      outgoing: boolean;
    }>(FKS_SQL, [t.oid]),
  ]);

  const primaryKey = pk.rows.map((r) => r.name);
  const pkSet = new Set(primaryKey);

  const toFk = (r: (typeof fks.rows)[number]): ForeignKey => ({
    name: r.name,
    fromSchema: r.from_schema,
    fromTable: r.from_table,
    fromColumns: r.from_columns,
    toSchema: r.to_schema,
    toTable: r.to_table,
    toColumns: r.to_columns,
    navigable: r.navigable,
  });
  // A self-referencing FK (e.g. employees.manager_id -> employees.id) appears in both lists.
  const foreignKeys = fks.rows.filter((r) => r.outgoing).map(toFk);
  const referencedBy = fks.rows
    .filter((r) => r.to_schema === t.schema && r.to_table === t.name)
    .map(toFk);

  return {
    oid: t.oid,
    schema: t.schema,
    name: t.name,
    kind: kindOf(t.relkind),
    estimatedRows: estimate(t.reltuples, t.relkind),
    primaryKey,
    foreignKeys,
    referencedBy,
    columns: cols.rows.map((c) => ({
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      isPrimaryKey: pkSet.has(c.name),
      hasDefault: c.has_default,
      isGenerated: c.is_generated,
      isIdentity: c.is_identity,
      canUpdate: c.can_update,
      category: c.category,
    })),
  };
}

export interface SchemaSummary {
  name: string;
  /** Browsable relations the role can SELECT in this schema. */
  relations: number;
}

const SCHEMAS_SQL = `
  SELECT n.nspname::text AS name,
         (SELECT count(*)::int
            FROM pg_catalog.pg_class c
           WHERE c.relnamespace = n.oid
             AND c.relkind IN ${BROWSABLE}
             AND NOT c.relispartition
             AND has_table_privilege(c.oid, 'SELECT')) AS relations
    FROM pg_catalog.pg_namespace n
   WHERE has_schema_privilege(n.oid, 'USAGE')
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND n.nspname NOT LIKE 'pg\\_toast%'
     AND n.nspname NOT LIKE 'pg\\_temp\\_%'
   ORDER BY n.nspname`;

/** Schemas the role can use. System schemas are left out. */
export async function listSchemas(client: pg.PoolClient): Promise<SchemaSummary[]> {
  const res = await client.query<SchemaSummary>(SCHEMAS_SQL);
  return res.rows;
}

/** True when `schema` exists and the role has USAGE on it. */
export async function schemaUsable(client: pg.PoolClient, schema: string): Promise<boolean> {
  const res = await client.query(
    "SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1 AND has_schema_privilege(oid, 'USAGE')",
    [schema],
  );
  return (res.rowCount ?? 0) > 0;
}
