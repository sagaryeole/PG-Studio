import { Router } from "express";
import { describeConnection, type Pools } from "../pools.js";
import { HttpError } from "../errors.js";

/** Saved connections and the databases on each server. Names only; never credentials. */
export function connectionRoutes(pools: Pools): Router {
  const r = Router();

  r.get("/connections", (_req, res) => {
    res.json({ connections: pools.connections.map(describeConnection) });
  });

  r.get("/databases", async (req, res) => {
    const raw = req.query["conn"];
    if (raw !== undefined && typeof raw !== "string") throw new HttpError(400, "Invalid conn");
    const conn = pools.connection(raw || undefined);
    const [current, databases] = await Promise.all([pools.defaultDatabase(conn), pools.listDatabases(conn)]);
    res.json({ connection: conn.id, default: current, databases });
  });

  return r;
}
