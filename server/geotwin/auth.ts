import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { parse as parseCookies } from "cookie";
import type { Express, Request, RequestHandler, Response } from "express";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getSessionCookieOptions } from "../_core/cookies";
import { ENV } from "../_core/env";
import { getPool } from "./database";

export const GEO_TWIN_SESSION_COOKIE = "geotwin_session";
export const GEO_TWIN_CSRF_COOKIE = "geotwin_csrf";
export const GEO_TWIN_CSRF_HEADER = "x-geotwin-csrf-token";
export const GEO_TWIN_TERMS_VERSION = "2026-10-15-v1";
export const GEO_TWIN_SESSION_EXPIRED_MESSAGE = "Your GeoTwinAI session has expired. Sign in again to continue.";
const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const CSRF_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_PER_IP = 60;
const RATE_LIMIT_PER_EMAIL = 8;
const DUMMY_PASSWORD_HASH = `scrypt$${"00".repeat(16)}$${"00".repeat(64)}`;
const rateWindows = new Map<string, { count: number; expiresAt: number }>();

export type GeoTwinPrincipal = {
  id: number;
  accountId: number;
  openId: string;
  name: string;
  email: string;
  loginMethod: "email";
  role: "user" | "admin";
  createdAt: Date;
  updatedAt: Date;
  lastSignedIn: Date;
};

type AccountRow = RowDataPacket & {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  created_at: Date | string;
  last_signed_in: Date | string;
};

type SessionAccountRow = RowDataPacket & {
  id: number;
  email: string;
  name: string;
  created_at: Date | string;
  last_signed_in: Date | string;
};

class AuthDatabaseUnavailable extends Error {}

const poolOrThrow = () => {
  const pool = getPool();
  if (!pool) throw new AuthDatabaseUnavailable("The account database is not available.");
  return pool;
};
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const parseCookie = (header: string | undefined, name: string) => {
  if (!header) return "";
  try { return parseCookies(header)[name] ?? ""; } catch { return ""; }
};
const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
};
const dateValue = (value: Date | string) => value instanceof Date ? value : new Date(value);

export function normalizeAccountEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().normalize("NFKC").toLowerCase();
  if (email.length < 6 || email.length > 254 || !/^[^\s@<>]+@[^\s@<>.]+(?:\.[^\s@<>.]+)+$/.test(email)) return null;
  return email;
}

function validPassword(value: unknown): value is string {
  return typeof value === "string" && Array.from(value).length >= 12 && Array.from(value).length <= 128 && Buffer.byteLength(value, "utf8") <= 512;
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

export async function hashAccountPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derivePassword(password, salt);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyAccountPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt" || !/^[0-9a-f]{32}$/i.test(parts[1]) || !/^[0-9a-f]{128}$/i.test(parts[2])) return false;
  const expected = Buffer.from(parts[2], "hex");
  const actual = await derivePassword(password, Buffer.from(parts[1], "hex"));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function ownerAccountId(): number | null {
  const raw = ENV.ownerAccountId.trim();
  const id = Number(raw);
  return raw && Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isConfiguredOwner(id: number, email: string) {
  const configuredEmail = normalizeAccountEmail(ENV.ownerEmail);
  return Boolean(configuredEmail && ownerAccountId() === id && configuredEmail === email);
}

function principalFor(row: SessionAccountRow): GeoTwinPrincipal {
  const id = Number(row.id);
  const createdAt = dateValue(row.created_at);
  const lastSignedIn = dateValue(row.last_signed_in);
  return {
    id,
    accountId: id,
    openId: `local_${id}`,
    name: row.name,
    email: row.email,
    loginMethod: "email",
    role: isConfiguredOwner(id, row.email) ? "admin" : "user",
    createdAt,
    updatedAt: createdAt,
    lastSignedIn,
  };
}

function publicUser(user: GeoTwinPrincipal) {
  return { id: user.id, accountId: user.accountId, openId: user.openId, name: user.name, email: user.email, role: user.role };
}

function getCsrfToken(req: Request, res: Response): string {
  const existing = parseCookie(req.headers.cookie, GEO_TWIN_CSRF_COOKIE);
  const token = /^[A-Za-z0-9_-]{43}$/.test(existing) ? existing : randomBytes(32).toString("base64url");
  res.cookie(GEO_TWIN_CSRF_COOKIE, token, {
    ...getSessionCookieOptions(req),
    httpOnly: false,
    maxAge: CSRF_MAX_AGE_MS,
  });
  return token;
}

export function hasValidGeoTwinCsrf(req: Request): boolean {
  const cookieToken = parseCookie(req.headers.cookie, GEO_TWIN_CSRF_COOKIE);
  const headerToken = req.get(GEO_TWIN_CSRF_HEADER) ?? "";
  return safeEqual(cookieToken, headerToken);
}

const csrfForPublicAuth: RequestHandler = (req, res, next) => {
  if (!hasValidGeoTwinCsrf(req)) return res.status(403).json({ error: "Refresh the sign-in page and try again." });
  return next();
};

export const geoTwinCsrfMiddleware: RequestHandler = (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) return next();
  if (!hasValidGeoTwinCsrf(req)) return res.status(403).json({ error: "Your request could not be verified. Refresh the page and try again." });
  return next();
};

function rateLimit(req: Request, res: Response, next: Parameters<RequestHandler>[2]) {
  const now = Date.now();
  if (rateWindows.size > 5000) for (const [key, item] of rateWindows) if (item.expiresAt <= now) rateWindows.delete(key);
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const email = normalizeAccountEmail(req.body?.email) ?? "invalid-email";
  const keys = [`ip:${ip}`, `email:${ip}:${email}`];
  const limits = [RATE_LIMIT_PER_IP, RATE_LIMIT_PER_EMAIL];
  let retryAfter = 0;
  for (let index = 0; index < keys.length; index++) {
    const existing = rateWindows.get(keys[index]);
    if (existing && existing.expiresAt > now && existing.count >= limits[index]) retryAfter = Math.max(retryAfter, existing.expiresAt - now);
  }
  if (retryAfter > 0) {
    res.setHeader("Retry-After", String(Math.ceil(retryAfter / 1000)));
    return res.status(429).json({ error: "Too many account attempts. Wait a few minutes before trying again." });
  }
  for (const key of keys) {
    const existing = rateWindows.get(key);
    rateWindows.set(key, existing && existing.expiresAt > now ? { ...existing, count: existing.count + 1 } : { count: 1, expiresAt: now + RATE_WINDOW_MS });
  }
  return next();
}

async function findAccountForSession(req: Request): Promise<GeoTwinPrincipal | null> {
  const token = parseCookie(req.headers.cookie, GEO_TWIN_SESSION_COOKIE);
  if (!token) return null;
  const pool = poolOrThrow();
  const [rows] = await pool.execute<SessionAccountRow[]>(
    "SELECT a.id, a.email, a.name, a.created_at, a.last_signed_in FROM geotwin_sessions s INNER JOIN geotwin_accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at > UTC_TIMESTAMP() LIMIT 1",
    [sha256(token)],
  );
  return rows[0] ? principalFor(rows[0]) : null;
}

export async function authenticateGeoTwinRequest(req: Request): Promise<GeoTwinPrincipal> {
  const user = await findAccountForSession(req);
  if (!user) throw new Error("No active GeoTwinAI account session");
  return user;
}

export const geoTwinSessionMiddleware: RequestHandler = (req, res, next) => {
  void findAccountForSession(req).then(user => {
    if (!user) return res.status(401).json({ error: GEO_TWIN_SESSION_EXPIRED_MESSAGE });
    res.locals.geotwinUser = user;
    return next();
  }).catch(error => {
    if (error instanceof AuthDatabaseUnavailable) return res.status(503).json({ error: "The GeoTwinAI account database is not available." });
    console.error("[GeoTwinAI auth] Session check failed", error);
    return res.status(503).json({ error: "Account verification is temporarily unavailable. Please retry." });
  });
};

async function createSession(accountId: number, req: Request, res: Response) {
  const pool = poolOrThrow();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
  await pool.execute<ResultSetHeader>(
    "INSERT INTO geotwin_sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)",
    [sha256(token), accountId, expiresAt],
  );
  await pool.execute("DELETE FROM geotwin_sessions WHERE expires_at <= UTC_TIMESTAMP() LIMIT 500");
  res.cookie(GEO_TWIN_SESSION_COOKIE, token, { ...getSessionCookieOptions(req), maxAge: SESSION_MAX_AGE_MS });
}

function requestError(res: Response, error: unknown) {
  if (error instanceof AuthDatabaseUnavailable) return res.status(503).json({ error: "The account database is not available. Please retry shortly." });
  console.error("[GeoTwinAI auth] Request failed", error);
  return res.status(500).json({ error: "The account request could not be completed. Please try again." });
}

function isDuplicateEmail(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ER_DUP_ENTRY");
}

export function registerGeoTwinAuthRoutes(app: Express) {
  app.use("/api/geotwin/auth", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/api/geotwin/auth/csrf", (req, res) => {
    res.json({ csrfToken: getCsrfToken(req, res) });
  });

  app.get("/api/geotwin/auth/me", (req, res) => {
    void findAccountForSession(req).then(user => res.json({ user: user ? publicUser(user) : null })).catch(error => requestError(res, error));
  });

  app.post("/api/geotwin/auth/register", csrfForPublicAuth, rateLimit, (req, res) => {
    void (async () => {
      const email = normalizeAccountEmail(req.body?.email);
      const name = typeof req.body?.name === "string" ? req.body.name.trim().replace(/\s+/g, " ") : "";
      const password: unknown = req.body?.password;
      if (!email) return res.status(400).json({ error: "Enter a valid email address." });
      if (name.length < 2 || Array.from(name).length > 100) return res.status(400).json({ error: "Enter your name (2–100 characters)." });
      if (!validPassword(password)) return res.status(400).json({ error: "Use a password between 12 and 128 characters." });
      if (req.body?.acceptedTerms !== true) return res.status(400).json({ error: "Accept the Terms & Conditions to create an account." });

      const pool = poolOrThrow();
      const passwordHash = await hashAccountPassword(password);
      let result: ResultSetHeader;
      try {
        const [insert] = await pool.execute<ResultSetHeader>(
          "INSERT INTO geotwin_accounts (email, name, password_hash, terms_version, terms_accepted_at, last_signed_in) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
          [email, name, passwordHash, GEO_TWIN_TERMS_VERSION],
        );
        result = insert;
      } catch (error) {
        if (isDuplicateEmail(error)) return res.status(409).json({ error: "An account already exists for that email. Sign in instead." });
        throw error;
      }
      const id = Number(result.insertId);
      await createSession(id, req, res);
      const user: GeoTwinPrincipal = { id, accountId: id, openId: `local_${id}`, name, email, loginMethod: "email", role: isConfiguredOwner(id, email) ? "admin" : "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };
      return res.status(201).json({ user: publicUser(user), termsVersion: GEO_TWIN_TERMS_VERSION });
    })().catch(error => requestError(res, error));
  });

  app.post("/api/geotwin/auth/login", csrfForPublicAuth, rateLimit, (req, res) => {
    void (async () => {
      const email = normalizeAccountEmail(req.body?.email);
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      if (!email || !password || Buffer.byteLength(password, "utf8") > 512) return res.status(400).json({ error: "Enter your email and password." });
      const pool = poolOrThrow();
      const [rows] = await pool.execute<AccountRow[]>(
        "SELECT id, email, name, password_hash, created_at, last_signed_in FROM geotwin_accounts WHERE email=? LIMIT 1",
        [email],
      );
      const account = rows[0];
      const matches = await verifyAccountPassword(password, account?.password_hash ?? DUMMY_PASSWORD_HASH);
      if (!account || !matches) return res.status(401).json({ error: "Email or password is incorrect." });
      await pool.execute("UPDATE geotwin_accounts SET last_signed_in=UTC_TIMESTAMP() WHERE id=?", [account.id]);
      await createSession(Number(account.id), req, res);
      const user: GeoTwinPrincipal = { ...principalFor(account), role: isConfiguredOwner(Number(account.id), account.email) ? "admin" : "user" };
      return res.json({ user: publicUser(user) });
    })().catch(error => requestError(res, error));
  });

  app.post("/api/geotwin/auth/logout", csrfForPublicAuth, (req, res) => {
    void (async () => {
      const token = parseCookie(req.headers.cookie, GEO_TWIN_SESSION_COOKIE);
      if (token) {
        const pool = poolOrThrow();
        await pool.execute("DELETE FROM geotwin_sessions WHERE token_hash=?", [sha256(token)]);
      }
      res.clearCookie(GEO_TWIN_SESSION_COOKIE, getSessionCookieOptions(req));
      return res.json({ success: true });
    })().catch(error => requestError(res, error));
  });
}
