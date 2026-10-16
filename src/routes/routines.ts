import { Router, type Request } from "express";
import type { Config } from "../config.js";
import type { Pools } from "../pools.js";
import { preferredSchema } from "./read.js";
import { schemaUsable } from "../catalog.js";
import { getRoutine, listRoutines } from "../routines.js";
import { HttpError } from "../errors.js";

const MAX_IDENT = 63 * 4; // 63 bytes; up to 4 bytes per UTF-8 char

/** ?schema= or the scope's default. Only ever used as a bind parameter. */
function schemaParam(req: Request, fallback: string): string {
  const raw = req.query["schema"];
  if (raw === undefined || raw === "") return fallback;
  if (typeof raw !== "string" || raw.length > MAX_IDENT) throw new HttpError(400, "Invalid schema");
  return raw;
}

/** A routine oid: digits only, so it is safe to bind as ::oid. */
function oidParam(req: Request): string {
  const oid = req.params["oid"];
  if (typeof oid !== "string" || !/^\d{1,10}$/.test(oid)) throw new HttpError(400, "Invalid function id");
  return oid;
}

/** Browse functions, procedures and aggregates. View only: nothing is ever executed. */
export function routineRoutes(config: Config, pools: Pools): Router {
  const r = Router();

  r.get("/routines", async (req, res) => {
    const scope = await pools.forRequest(req);
    const schema = schemaParam(req, preferredSchema(scope, config));
    const routines = await scope.db.withReadOnly(async (c) => {
      if (!(await schemaUsable(c, schema))) return null;
      return listRoutines(c, schema);
    });
    if (!routines) throw new HttpError(404, "Schema not found");
    res.json({ schema, routines });
  });

  r.get("/routines/:oid", async (req, res) => {
    const oid = oidParam(req);
    const { db } = await pools.forRequest(req);
    const routine = await db.withReadOnly((c) => getRoutine(c, oid));
    if (!routine) throw new HttpError(404, "Function not found");
    res.json(routine);
  });

  return r;
}
