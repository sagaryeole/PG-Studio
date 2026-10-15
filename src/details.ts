/**
 * Table details: sizes, stats, columns with defaults and comments, indexes,
 * constraints, triggers, view definition, and an approximate DDL script.
 * Everything comes from the system catalog; nothing reads table data except
 * the explicit row count.
 */
import pg from "pg";
import type { TableMeta } from "./catalog.js";
import { buildWhere, isFiltered, type ViewSpec } from "./query.js";

const q = pg.escapeIdentifier;

export interface ColumnDetail {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  /** "always" | "by default" for identity columns. */
  identity: string | null;
  /** Expression for GENERATED ALWAYS AS (...) STORED columns. */
  generated: string | null;
  comment: string | null;
}

export interface IndexDetail {
  name: string;
  definition: string;
  primary: boolean;
  unique: boolean;
  /** Backs a PRIMARY KEY / UNIQUE / EXCLUDE constraint (so the DDL creates it via the constraint). */
  constraintBacked: boolean;
  valid: boolean;
  sizeBytes: number | null;
  scans: number | null;
}

export interface ConstraintDetail {
  name: string;
  /** primary key | unique | foreign key | check | exclusion | not null */
  type: string;
  definition: string;
}

export interface TriggerDetail {
  name: string;
  definition: string;
  enabled: boolean;
  /** pg_proc oid of the trigger function, for linking to the routine view. */
  functionOid: string | null;
}

export interface TableDetails {
  schema: string;
  name: string;
  kind: TableMeta["kind"];
  comment: string | null;
  owner: string;
  sizes: { totalBytes: number; tableBytes: number; indexBytes: number; toastBytes: number } | null;
  stats: {
    liveRows: number | null;
    deadRows: number | null;
    lastVacuum: string | null;
    lastAnalyze: string | null;
    seqScans: number | null;
    indexScans: number | null;
  } | null;
  partitionKey: string | null;
  partitions: number | null;
  viewDefinition: string | null;
  columns: ColumnDetail[];
  indexes: IndexDetail[];
  constraints: ConstraintDetail[];
  triggers: TriggerDetail[];
  /** Approximate CREATE statement(s) rebuilt from the catalog. */
  ddl: string;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const OVERVIEW_SQL = `
  SELECT obj_description(c.oid, 'pg_class')            AS comment,
         pg_get_userbyid(c.relowner)::text              AS owner,
         CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS partition_key,
         CASE WHEN c.relkind = 'p'
              THEN (SELECT count(*) FROM pg_partition_tree(c.oid) WHERE isleaf) END AS partitions,
         CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END AS view_definition,
         CASE WHEN c.relkind IN ('r', 'm') THEN pg_total_relation_size(c.oid)
              WHEN c.relkind = 'p' THEN (SELECT coalesce(sum(pg_total_relation_size(relid)), 0)
                                           FROM pg_partition_tree(c.oid))
         END                                            AS total_bytes,
         CASE WHEN c.relkind IN ('r', 'm') THEN pg_relation_size(c.oid)
              WHEN c.relkind = 'p' THEN (SELECT coalesce(sum(pg_relation_size(relid)), 0)
                                           FROM pg_partition_tree(c.oid))
         END                                            AS table_bytes,
         CASE WHEN c.relkind IN ('r', 'm') THEN pg_indexes_size(c.oid)
              WHEN c.relkind = 'p' THEN (SELECT coalesce(sum(pg_indexes_size(relid)), 0)
                                           FROM pg_partition_tree(c.oid))
         END                                            AS index_bytes,
         s.n_live_tup, s.n_dead_tup,
         greatest(s.last_vacuum, s.last_autovacuum)::text  AS last_vacuum,
         greatest(s.last_analyze, s.last_autoanalyze)::text AS last_analyze,
         s.seq_scan, s.idx_scan
    FROM pg_catalog.pg_class c
    LEFT JOIN pg_catalog.pg_stat_all_tables s ON s.relid = c.oid
   WHERE c.oid = $1::oid`;

const COLUMN_DETAILS_SQL = `
  SELECT a.attname::text                                  AS name,
         pg_catalog.format_type(a.atttypid, a.atttypmod)  AS type,
         NOT a.attnotnull                                 AS nullable,
         CASE WHEN a.attgenerated = '' THEN pg_get_expr(d.adbin, d.adrelid) END AS default_expr,
         CASE a.attidentity WHEN 'a' THEN 'always' WHEN 'd' THEN 'by default' END AS identity,
         CASE WHEN a.attgenerated <> '' THEN pg_get_expr(d.adbin, d.adrelid) END AS generated,
         col_description(a.attrelid, a.attnum)            AS comment
    FROM pg_catalog.pg_attribute a
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = $1::oid
     AND a.attnum > 0
     AND NOT a.attisdropped
   ORDER BY a.attnum`;

const INDEXES_SQL = `
  SELECT i.relname::text                       AS name,
         pg_get_indexdef(ix.indexrelid)        AS definition,
         ix.indisprimary                       AS is_primary,
         ix.indisunique                        AS is_unique,
         ix.indisvalid                         AS is_valid,
         EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con
                  WHERE con.conindid = ix.indexrelid
                    AND con.conrelid = ix.indrelid
                    AND con.contype IN ('p', 'u', 'x')) AS constraint_backed,
         pg_relation_size(ix.indexrelid)       AS size_bytes,
         st.idx_scan                           AS scans
    FROM pg_catalog.pg_index ix
    JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
    LEFT JOIN pg_catalog.pg_stat_all_indexes st ON st.indexrelid = ix.indexrelid
   WHERE ix.indrelid = $1::oid
   ORDER BY ix.indisprimary DESC, ix.indisunique DESC, i.relname`;

const CONSTRAINTS_SQL = `
  SELECT con.conname::text                      AS name,
         con.contype::text                      AS contype,
         pg_get_constraintdef(con.oid, true)    AS definition
    FROM pg_catalog.pg_constraint con
   WHERE con.conrelid = $1::oid
     AND con.contype IN ('p', 'u', 'f', 'c', 'x')
   ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 WHEN 'c' THEN 3 ELSE 4 END,
            con.conname`;

const TRIGGERS_SQL = `
  SELECT t.tgname::text                    AS name,
         pg_get_triggerdef(t.oid, true)    AS definition,
         t.tgenabled <> 'D'                AS enabled,
         t.tgfoid::text                    AS function_oid
    FROM pg_catalog.pg_trigger t
   WHERE t.tgrelid = $1::oid
     AND NOT t.tgisinternal
   ORDER BY t.tgname`;

const CONTYPE: Record<string, string> = {
  p: "primary key",
  u: "unique",
  f: "foreign key",
  c: "check",
  x: "exclusion",
};

/** Quote a string as an SQL literal (for COMMENT ON in the generated DDL only). */
function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function buildDdl(
  t: TableMeta,
  ov: { comment: string | null; partition_key: string | null; view_definition: string | null },
  columns: ColumnDetail[],
  indexes: IndexDetail[],
  constraints: ConstraintDetail[],
  triggers: TriggerDetail[],
): string {
  const rel = `${q(t.schema)}.${q(t.name)}`;
  const out: string[] = [];

  if (t.kind === "view" || t.kind === "matview") {
    const kw = t.kind === "view" ? "VIEW" : "MATERIALIZED VIEW";
    out.push(`CREATE ${kw} ${rel} AS\n${(ov.view_definition ?? "").trim().replace(/;$/, "")};`);
  } else {
    const lines = columns.map((c) => {
      let l = `    ${q(c.name)} ${c.type}`;
      if (c.generated) l += ` GENERATED ALWAYS AS ${c.generated} STORED`;
      else if (c.identity) l += ` GENERATED ${c.identity.toUpperCase()} AS IDENTITY`;
      else if (c.default) l += ` DEFAULT ${c.default}`;
      if (!c.nullable) l += " NOT NULL";
      return l;
    });
    for (const con of constraints) lines.push(`    CONSTRAINT ${q(con.name)} ${con.definition}`);
    let create = `CREATE TABLE ${rel} (\n${lines.join(",\n")}\n)`;
    if (ov.partition_key) create += ` PARTITION BY ${ov.partition_key}`;
    out.push(`${create};`);
  }

  for (const ix of indexes) if (!ix.constraintBacked) out.push(`${ix.definition};`);
  for (const tg of triggers) out.push(`${tg.definition};`);

  const kwComment = t.kind === "view" ? "VIEW" : t.kind === "matview" ? "MATERIALIZED VIEW" : "TABLE";
  if (ov.comment) out.push(`COMMENT ON ${kwComment} ${rel} IS ${lit(ov.comment)};`);
  for (const c of columns) {
    if (c.comment) out.push(`COMMENT ON COLUMN ${rel}.${q(c.name)} IS ${lit(c.comment)};`);
  }
  return out.join("\n\n");
}

export async function fetchDetails(client: pg.PoolClient, t: TableMeta): Promise<TableDetails> {
  // With an empty search_path, pg_get_*def() schema-qualifies every name, so the
  // DDL is correct no matter which schema it is run from. SET LOCAL: this
  // transaction only (it always rolls back).
  await client.query("SELECT set_config('search_path', '', true)");
  const [ovRes, colRes, ixRes, conRes, tgRes] = await Promise.all([
    client.query(OVERVIEW_SQL, [t.oid]),
    client.query(COLUMN_DETAILS_SQL, [t.oid]),
    client.query(INDEXES_SQL, [t.oid]),
    client.query(CONSTRAINTS_SQL, [t.oid]),
    client.query(TRIGGERS_SQL, [t.oid]),
  ]);
  const ov = ovRes.rows[0] ?? {};

  const columns: ColumnDetail[] = colRes.rows.map((r) => ({
    name: r.name,
    type: r.type,
    nullable: r.nullable,
    default: r.default_expr ?? null,
    identity: r.identity ?? null,
    generated: r.generated ?? null,
    comment: r.comment ?? null,
  }));
  const indexes: IndexDetail[] = ixRes.rows.map((r) => ({
    name: r.name,
    definition: r.definition,
    primary: r.is_primary,
    unique: r.is_unique,
    constraintBacked: r.constraint_backed,
    valid: r.is_valid,
    sizeBytes: num(r.size_bytes),
    scans: num(r.scans),
  }));
  const constraints: ConstraintDetail[] = conRes.rows.map((r) => ({
    name: r.name,
    type: CONTYPE[r.contype] ?? r.contype,
    definition: r.definition,
  }));
  const triggers: TriggerDetail[] = tgRes.rows.map((r) => ({
    name: r.name,
    definition: r.definition,
    enabled: r.enabled,
    functionOid: r.function_oid ?? null,
  }));

  const total = num(ov.total_bytes);
  const tableBytes = num(ov.table_bytes) ?? 0;
  const indexBytes = num(ov.index_bytes) ?? 0;

  return {
    schema: t.schema,
    name: t.name,
    kind: t.kind,
    comment: ov.comment ?? null,
    owner: ov.owner ?? "",
    sizes:
      total === null
        ? null
        : { totalBytes: total, tableBytes, indexBytes, toastBytes: Math.max(0, total - tableBytes - indexBytes) },
    stats:
      t.kind === "view"
        ? null
        : {
            liveRows: num(ov.n_live_tup),
            deadRows: num(ov.n_dead_tup),
            lastVacuum: ov.last_vacuum ?? null,
            lastAnalyze: ov.last_analyze ?? null,
            seqScans: num(ov.seq_scan),
            indexScans: num(ov.idx_scan),
          },
    partitionKey: ov.partition_key ?? null,
    partitions: num(ov.partitions),
    viewDefinition: ov.view_definition ?? null,
    columns,
    indexes,
    constraints,
    triggers,
    ddl: buildDdl(t, ov, columns, indexes, constraints, triggers),
  };
}

/** Exact row count of the current view (filters + search), bounded by the statement timeout. */
export async function countRows(client: pg.PoolClient, t: TableMeta, spec: ViewSpec): Promise<{ count: string; filtered: boolean }> {
  const params: unknown[] = [];
  const where = buildWhere(t, spec, params);
  const res = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${q(t.schema)}.${q(t.name)} ${where}`,
    params,
  );
  return { count: res.rows[0]?.n ?? "0", filtered: isFiltered(spec) };
}

