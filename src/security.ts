/**
 * HTTP hardening for a localhost tool.
 *
 * Binding to 127.0.0.1 is not enough on its own: a malicious web page can use
 * DNS rebinding to make your browser send requests to 127.0.0.1 under its own
 * hostname. Checking the Host header blocks that.
 */
import type { NextFunction, Request, Response } from "express";

export function hostCheck(port: number) {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return (req: Request, res: Response, next: NextFunction): void => {
    const host = (req.headers.host ?? "").toLowerCase();
    if (!allowed.has(host)) {
      res.status(403).type("text/plain").send("Forbidden host");
      return;
    }
    next();
  };
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
}

/**
 * Edit seam (future): every state-changing request must come from this app's
 * own page. Browsers always send Origin on POST/PUT/PATCH/DELETE, and a
 * custom header cannot be set cross-site without a CORS preflight we never
 * grant. Today there are no write routes, so this simply rejects them.
 */
export function requireSameOriginForWrites(port: number) {
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === "GET" || req.method === "HEAD") {
      next();
      return;
    }
    const origin = req.headers.origin ?? "";
    if (!origins.has(origin) || req.headers["x-pg-studio"] !== "1") {
      res.status(403).json({ error: "Cross-origin write rejected" });
      return;
    }
    next();
  };
}
