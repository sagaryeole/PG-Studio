import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { loadConfig } from "./config.js";
import { checkRole } from "./catalog.js";
import { createDb, redact } from "./db.js";
import { errorHandler } from "./errors.js";
import { readRoutes } from "./routes/read.js";
import { routineRoutes } from "./routes/routines.js";
import { hostCheck, requireSameOriginForWrites, securityHeaders } from "./security.js";

const config = loadConfig();
const db = createDb(config);

const app = express();
app.disable("x-powered-by");
app.set("query parser", "simple");

app.use(hostCheck(config.port));
app.use(securityHeaders);

const api = express.Router();
api.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
api.use(requireSameOriginForWrites(config.port));
api.use(readRoutes(config, db));
api.use(routineRoutes(config, db));
// Edit seam: mount `writeRoutes(config, writeDb)` here, only when explicitly enabled.
api.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use("/api", api);

const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.resolve(here, "..", "public"), { index: "index.html" }));

app.use(errorHandler);

const server = app.listen(config.port, config.host, () => {
  console.log(`PG Studio on http://${config.host}:${config.port}  (schema: ${config.schema}, read-only)`);
  db.withReadOnly((c) => checkRole(c, config.schema))
    .then((r) => {
      if (r.isSuperuser || r.writableTables > 0) {
        console.warn(
          `\n  WARNING: role "${r.role}" can modify data` +
            (r.isSuperuser ? " (superuser)" : ` (${r.writableTables} writable tables)`) +
            ".\n  READ ONLY transactions are a guard rail, not a boundary." +
            "\n  Use a SELECT-only role in DATABASE_URL (see README).\n",
        );
      } else {
        console.log(`  Connected as "${r.role}" (no write privileges in ${config.schema}).`);
      }
    })
    .catch((err: unknown) => console.error("[db] startup check failed:", redact(err)));
});

function shutdown(): void {
  server.close(() => {
    db.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
