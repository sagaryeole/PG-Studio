#!/usr/bin/env node
/**
 * `pg-studio` command: turns flags into the same environment variables the
 * server reads, then starts it. Everything else lives in server.ts.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const HELP = `PG Studio: a fast, read-only PostgreSQL browser on localhost.

Usage
  pg-studio [postgres-url] [options]

Options
  -u, --url <url>           Connection string (same as DATABASE_URL)
  -c, --connections <file>  Saved connections file (default: ./connections.json)
  -p, --port <n>            Port on 127.0.0.1 (default: 4321)
  -s, --schema <name>       Schema to open first (default: public)
  -e, --env-file <file>     Load settings from an env file, e.g. .env
  -o, --open                Open the browser once the server is up
  -v, --version             Print the version
  -h, --help                Show this help

Examples
  pg-studio postgres://pgstudio_ro@127.0.0.1:5432/mydb --open
  pg-studio --connections ~/pg-studio/connections.json
  PGPASSWORD=... pg-studio -u postgres://readonly@db.internal/app

Leave passwords out of the URL where you can: other users on this machine
can see command lines. Use ~/.pgpass, PGPASSWORD or a connections file.
Docs: https://github.com/sagaryeole/PG-Studio`;

function fail(message: string): never {
  console.error(`pg-studio: ${message}\nRun "pg-studio --help" for usage.`);
  process.exit(2);
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
  return pkg.version ?? "unknown";
}

/** Open a URL in the default browser, best effort. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
  } catch {
    /* no browser available; the URL is printed anyway */
  }
}

async function waitAndOpen(port: number): Promise<void> {
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${url}api/connections`);
      if (res.ok) {
        openBrowser(url);
        return;
      }
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string", short: "u" },
      connections: { type: "string", short: "c" },
      port: { type: "string", short: "p" },
      schema: { type: "string", short: "s" },
      "env-file": { type: "string", short: "e" },
      open: { type: "boolean", short: "o" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (err) {
  fail((err as Error).message);
}
const { values: opts, positionals } = parsed;

if (opts.help) {
  console.log(HELP);
  process.exit(0);
}
if (opts.version) {
  console.log(version());
  process.exit(0);
}
if (positionals.length > 1) fail("expected at most one connection URL");
if (positionals[0] && opts.url) fail("give the URL either as an argument or with --url, not both");

if (opts["env-file"]) {
  if (typeof process.loadEnvFile !== "function") fail("--env-file needs Node.js 20.12 or newer");
  try {
    process.loadEnvFile(opts["env-file"]);
  } catch (err) {
    fail(`cannot read ${opts["env-file"]}: ${(err as { code?: string }).code ?? "error"}`);
  }
}

// Flags win over the environment and the env file.
const url = positionals[0] ?? opts.url;
if (url !== undefined) {
  process.env["DATABASE_URL"] = url;
  try {
    if (new URL(url).password) {
      console.warn("  Note: the password in this URL is visible to other local users (ps, shell history).");
      console.warn("        Prefer ~/.pgpass, PGPASSWORD or a connections file.\n");
    }
  } catch {
    /* not a URL; config.ts reports it */
  }
}
if (opts.connections !== undefined) process.env["CONNECTIONS_FILE"] = opts.connections;
if (opts.port !== undefined) process.env["PORT"] = opts.port;
if (opts.schema !== undefined) process.env["PG_SCHEMA"] = opts.schema;

try {
  await import("./server.js");
} catch (err) {
  // Config errors are meant for people: print the message, not a stack trace.
  console.error(`pg-studio: ${(err as Error).message}`);
  process.exit(1);
}

if (opts.open) void waitAndOpen(Number(process.env["PORT"] ?? 4321));
