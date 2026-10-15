import type { CookieOptions, Request } from "express";

export function getSessionCookieOptions(_req: Request): CookieOptions {
  // The managed Preview proxy forwards the public protocol. The NODE_ENV fallback
  // makes production HTTPS safe if an upstream omits that forwarding header.
  const forwardedProtocol = _req.headers["x-forwarded-proto"]?.toString().split(",")[0]?.trim().toLowerCase();
  const publicHttps = forwardedProtocol === "https" || process.env.NODE_ENV === "production";
  return { httpOnly: true, path: "/", sameSite: publicHttps ? "none" : "lax", secure: publicHttps };
}
