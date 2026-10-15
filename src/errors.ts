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
    // Filter value doesn't fit the column type, e.g. "abc" for an integer column.
    // The message only echoes the user's own input, so it is safe to return.
    case "22P02": // invalid_text_representation
    case "22007": // invalid_datetime_format
    case "22008": // datetime_field_overflow
    case "22003": // numeric_value_out_of_range
    case "22001": // string_data_right_truncation
    case "22021": // character_not_in_repertoire
      return new HttpError(400, `Filter value: ${String((err as { message?: unknown }).message ?? "invalid")}`);
    case "42883": // undefined_function: e.g. sorting or comparing a json column
      return new HttpError(400, "That sort or comparison isn't supported for this column's type");
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
