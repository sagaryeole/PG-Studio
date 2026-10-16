/**
 * HTTP hardening for a localhost tool.
 *
 * Binding to 127.0.0.1 is not enough on its own: a malicious web page can use
 * DNS rebinding to make your browser send requests to 127.0.0.1 under its own
 * hostname. Checking the Host header blocks that.
 */
import type { NextFunction, Request, Response } from "express";

/**
 * Only loopback host names are accepted. `anyPort` is for the container
 * image, where Docker may publish the app on a different host port; the
 * DNS-rebinding defence is the host NAME, so the port can vary safely.
 */
function isLocalAuthority(value: string, port: number, anyPort: boolean): boolean {
  const m = /^(127\.0\.0\.1|localhost):(\d{1,5})$/.exec(value.toLowerCase());
  return !!m && (anyPort || Number(m[2]) === port);
}

export function hostCheck(port: number, anyPort = false) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isLocalAuthority(req.headers.host ?? "", port, anyPort)) {
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
export function requireSameOriginForWrites(port: number, anyPort = false) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === "GET" || req.method === "HEAD") {
      next();
      return;
    }
    const origin = req.headers.origin ?? "";
    const local = origin.startsWith("http://") && isLocalAuthority(origin.slice("http://".length), port, anyPort);
    if (!local || req.headers["x-pg-studio"] !== "1") {
      res.status(403).json({ error: "Cross-origin write rejected" });
      return;
    }
    next();
  };
}
