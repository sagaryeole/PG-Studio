import type { NextFunction, Request, Response } from "express";
import { redact } from "./db.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Map a few Postgres error codes to safe, useful messages. Everything else is generic. */
function fromPg(err: unknown): HttpError | null {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return null;
  switch (code) {
    case "57014":
      return new HttpError(504, "Query timed out (STATEMENT_TIMEOUT_MS)");
    case "42501":
      return new HttpError(403, "Permission denied for this table");
    case "25006":
      return new HttpError(409, "Write attempted in a read-only transaction");
    case "28P01":
    case "28000":
      return new HttpError(502, "Database authentication failed");
    case "3D000":
      return new HttpError(502, "Database does not exist");
    default:
      return null;
  }
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const known = err instanceof HttpError ? err : fromPg(err);
  if (known) {
    res.status(known.status).json({ error: known.message });
    return;
  }
  const errno = (err as { code?: unknown } | null)?.code;
  if (errno === "ECONNREFUSED" || errno === "ENOTFOUND" || errno === "ETIMEDOUT") {
    res.status(502).json({ error: "Cannot reach the database" });
    return;
  }
  console.error("[http] unhandled error:", redact(err));
  res.status(500).json({ error: "Internal error" });
}
