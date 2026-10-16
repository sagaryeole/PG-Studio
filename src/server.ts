import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { loadConfig } from "./config.js";
import { checkRole } from "./catalog.js";
import { redact } from "./db.js";
import { errorHandler } from "./errors.js";
import { connectionRoutes } from "./routes/connections.js";
import { readRoutes } from "./routes/read.js";
import { routineRoutes } from "./routes/routines.js";
import { Pools } from "./pools.js";
import { hostCheck, requireSameOriginForWrites, securityHeaders } from "./security.js";

const config = loadConfig();
const pools = new Pools(config);

const app = express();
app.disable("x-powered-by");
app.set("query parser", "simple");

app.use(hostCheck(config.port, config.container));
app.use(securityHeaders);

const api = express.Router();
api.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
api.use(requireSameOriginForWrites(config.port, config.container));
api.use(connectionRoutes(pools));
api.use(readRoutes(config, pools));
api.use(routineRoutes(config, pools));
// Edit seam: mount `writeRoutes(config, writeDb)` here, only when explicitly enabled.
api.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use("/api", api);

const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.resolve(here, "..", "public"), { index: "index.html" }));

app.use(errorHandler);

// Express 5 also calls this on a listen error; the "error" handler below reports it.
const server = app.listen(config.port, config.host, (err?: Error) => {
  if (err) return;
  const n = config.connections.length;
  const summary = `(read-only, ${n} connection${n === 1 ? "" : "s"} from ${config.connectionsSource})`;
  if (config.container) {
    console.log(`PG Studio listening on port ${config.port} inside the container ${summary}`);
    console.log(`  Publish it to localhost only, e.g.  docker run -p 127.0.0.1:${config.port}:${config.port} ...`);
  } else {
    console.log(`PG Studio on http://${config.host}:${config.port}  ${summary}`);
  }
  for (const conn of config.connections) {
    const schema = conn.schema ?? config.schema;
    pools
      .defaultDb(conn)
      .withReadOnly((c) => checkRole(c, schema))
      .then((r) => {
        if (r.isSuperuser || r.writableTables > 0) {
          console.warn(
            `\n  WARNING: "${conn.name}": role "${r.role}" can modify data` +
              (r.isSuperuser ? " (superuser)" : ` (${r.writableTables} writable tables in ${schema})`) +
              ".\n  READ ONLY transactions are a guard rail, not a boundary." +
              "\n  Use a SELECT-only role for this connection (see README).\n",
          );
        } else {
          console.log(`  ${conn.name}: connected as "${r.role}" (no write privileges in ${schema}).`);
        }
      })
      .catch((err: unknown) => console.error(`[db] ${conn.name}: startup check failed:`, redact(err)));
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${config.port} is already in use. Pick another with PORT=... (or pg-studio --port ...).`);
  } else {
    console.error("[http] cannot listen:", err.message);
  }
  process.exit(1);
});

function shutdown(): void {
  server.close(() => {
    pools.closeAll().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
