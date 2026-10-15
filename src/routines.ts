/**
 * Functions, procedures and aggregates, read from the system catalog. View only:
 * nothing here ever calls a routine. User input (schema, oid) is ONLY ever used
 * as a bind parameter.
 */
import type pg from "pg";

export type RoutineKind = "function" | "procedure" | "aggregate" | "window";

export interface RoutineSummary {
  oid: string;
  name: string;
  kind: RoutineKind;
  /** Identity arguments, e.g. "book_id integer, since date". Empty for no arguments. */
  args: string;
  /** Result type; null for procedures. */
  returns: string | null;
  language: string;
}

export interface TriggerUse {
  schema: string;
  table: string;
  trigger: string;
}

export interface RoutineDetail extends RoutineSummary {
  schema: string;
  volatility: "immutable" | "stable" | "volatile";
  strict: boolean;
  securityDefiner: boolean;
  leakproof: boolean;
  parallel: "safe" | "restricted" | "unsafe";
  cost: number;
  /** Estimated result rows; only for set-returning functions. */
  rows: number | null;
  owner: string;
  comment: string | null;
  /** pg_get_functiondef(); null for aggregates, which have no CREATE FUNCTION form. */
  definition: string | null;
  /** Short summary for aggregates (transition function, state type); null otherwise. */
  aggregate: { transitionFunction: string; stateType: string; finalFunction: string | null } | null;
  /** Triggers on tables the role can SELECT that call this function. */
  usedByTriggers: TriggerUse[];
}

const KIND: Record<string, RoutineKind> = { f: "function", p: "procedure", a: "aggregate", w: "window" };
const VOLATILITY = { i: "immutable", s: "stable", v: "volatile" } as const;
const PARALLEL = { s: "safe", r: "restricted", u: "unsafe" } as const;

// Routines owned by an extension (pg_depend deptype 'e') are skipped, like psql's \df.
const LIST_SQL = `
  SELECT p.oid::text                                   AS oid,
         p.proname::text                               AS name,
         p.prokind::text                               AS prokind,
         pg_get_function_identity_arguments(p.oid)     AS args,
         CASE WHEN p.prokind <> 'p' THEN pg_get_function_result(p.oid) END AS returns,
         l.lanname::text                               AS language
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
   WHERE n.nspname = $1
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid = 'pg_catalog.pg_proc'::regclass
                        AND d.objid = p.oid
                        AND d.deptype = 'e')
   ORDER BY p.proname, args`;

export async function listRoutines(client: pg.PoolClient, schema: string): Promise<RoutineSummary[]> {
  const res = await client.query(LIST_SQL, [schema]);
  return res.rows.map((r) => ({
    oid: r.oid,
    name: r.name,
    kind: KIND[r.prokind] ?? "function",
    args: r.args,
    returns: r.returns ?? null,
    language: r.language,
  }));
}

const DETAIL_SQL = `
  SELECT p.oid::text                                   AS oid,
         n.nspname::text                               AS schema,
         p.proname::text                               AS name,
         p.prokind::text                               AS prokind,
         pg_get_function_identity_arguments(p.oid)     AS args,
         CASE WHEN p.prokind <> 'p' THEN pg_get_function_result(p.oid) END AS returns,
         l.lanname::text                               AS language,
         p.provolatile::text                           AS volatility,
         p.proisstrict                                 AS strict,
         p.prosecdef                                   AS security_definer,
         p.proleakproof                                AS leakproof,
         p.proparallel::text                           AS parallel,
         p.procost                                     AS cost,
         CASE WHEN p.proretset THEN p.prorows END      AS rows,
         pg_get_userbyid(p.proowner)::text             AS owner,
         obj_description(p.oid, 'pg_proc')             AS comment,
         CASE WHEN p.prokind <> 'a' THEN pg_get_functiondef(p.oid) END AS definition,
         ag.aggtransfn::text                           AS agg_transfn,
         pg_catalog.format_type(ag.aggtranstype, NULL) AS agg_state_type,
         CASE WHEN ag.aggfinalfn <> 0 THEN ag.aggfinalfn::text END AS agg_finalfn
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    LEFT JOIN pg_catalog.pg_aggregate ag ON ag.aggfnoid = p.oid
   WHERE p.oid = $1::oid
     AND has_schema_privilege(n.oid, 'USAGE')`;

const TRIGGER_USES_SQL = `
  SELECT n.nspname::text AS schema, c.relname::text AS "table", t.tgname::text AS trigger
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE t.tgfoid = $1::oid
     AND NOT t.tgisinternal
     AND has_table_privilege(c.oid, 'SELECT')
   ORDER BY n.nspname, c.relname, t.tgname`;

/** Full detail for one routine, or null if it doesn't exist or its schema isn't usable by this role. */
export async function getRoutine(client: pg.PoolClient, oid: string): Promise<RoutineDetail | null> {
  // Empty search_path: pg_get_functiondef() and type names come out schema-qualified.
  await client.query("SELECT set_config('search_path', '', true)");
  const res = await client.query(DETAIL_SQL, [oid]);
  const r = res.rows[0];
  if (!r) return null;
  const uses = await client.query(TRIGGER_USES_SQL, [oid]);
  const isAgg = r.prokind === "a";
  return {
    oid: r.oid,
    schema: r.schema,
    name: r.name,
    kind: KIND[r.prokind] ?? "function",
    args: r.args,
    returns: r.returns ?? null,
    language: r.language,
    volatility: VOLATILITY[r.volatility as keyof typeof VOLATILITY] ?? "volatile",
    strict: r.strict,
    securityDefiner: r.security_definer,
    leakproof: r.leakproof,
    parallel: PARALLEL[r.parallel as keyof typeof PARALLEL] ?? "unsafe",
    cost: Number(r.cost),
    rows: r.rows === null ? null : Number(r.rows),
    owner: r.owner,
    comment: r.comment ?? null,
    definition: r.definition ?? null,
    aggregate: isAgg
      ? { transitionFunction: r.agg_transfn, stateType: r.agg_state_type, finalFunction: r.agg_finalfn ?? null }
      : null,
    usedByTriggers: uses.rows.map((u) => ({ schema: u.schema, table: u.table, trigger: u.trigger })),
  };
}

