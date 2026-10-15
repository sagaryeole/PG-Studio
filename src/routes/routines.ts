import { Router, type Request } from "express";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { schemaUsable } from "../catalog.js";
import { getRoutine, listRoutines } from "../routines.js";
import { HttpError } from "../errors.js";

const MAX_IDENT = 63 * 4; // 63 bytes; up to 4 bytes per UTF-8 char

/** ?schema= or the configured default. Only ever used as a bind parameter. */
function schemaParam(req: Request, config: Config): string {
  const raw = req.query["schema"];
  if (raw === undefined || raw === "") return config.schema;
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
export function routineRoutes(config: Config, db: Db): Router {
  const r = Router();

  r.get("/routines", async (req, res) => {
    const schema = schemaParam(req, config);
    const routines = await db.withReadOnly(async (c) => {
      if (!(await schemaUsable(c, schema))) return null;
      return listRoutines(c, schema);
    });
    if (!routines) throw new HttpError(404, "Schema not found");
    res.json({ schema, routines });
  });

  r.get("/routines/:oid", async (req, res) => {
    const oid = oidParam(req);
    const routine = await db.withReadOnly((c) => getRoutine(c, oid));
    if (!routine) throw new HttpError(404, "Function not found");
    res.json(routine);
  });

  return r;
}
