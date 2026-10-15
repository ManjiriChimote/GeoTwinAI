import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), accounts: [] as Record<string, unknown>[], sessions: new Map<string, number>() }));

vi.mock("./database", () => ({
  getPool: () => ({
    execute: mocks.execute,
  }),
}));

import {
  GEO_TWIN_CSRF_HEADER,
  GEO_TWIN_CSRF_COOKIE,
  GEO_TWIN_SESSION_COOKIE,
  GEO_TWIN_TERMS_VERSION,
  hashAccountPassword,
  normalizeAccountEmail,
  registerGeoTwinAuthRoutes,
  verifyAccountPassword,
} from "./auth";

afterEach(() => {
  mocks.execute.mockReset();
  mocks.accounts.length = 0;
  mocks.sessions.clear();
  vi.unstubAllEnvs();
});

async function withAuthServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  registerGeoTwinAuthRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  try { return await run(`http://127.0.0.1:${port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

function cookieValue(header: string | null, name: string) {
  const match = header?.match(new RegExp(`(?:^|[,;]\\s*)${name}=([^;,]+)`));
  return match?.[1] ?? "";
}

function mockPersistentDatabase() {
  mocks.execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith("INSERT INTO geotwin_accounts")) {
      const [email, name, passwordHash, termsVersion] = params;
      const account = { id: mocks.accounts.length + 1, email, name, password_hash: passwordHash, terms_version: termsVersion, created_at: new Date("2026-10-10T10:00:00Z"), last_signed_in: new Date("2026-10-10T10:00:00Z") };
      mocks.accounts.push(account);
      return [{ insertId: account.id, affectedRows: 1 }, []];
    }
    if (sql.startsWith("INSERT INTO geotwin_sessions")) {
      mocks.sessions.set(String(params[0]), Number(params[1]));
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith("DELETE FROM geotwin_sessions WHERE expires_at")) return [{ affectedRows: 0 }, []];
    if (sql.startsWith("DELETE FROM geotwin_sessions WHERE token_hash")) {
      const removed = mocks.sessions.delete(String(params[0]));
      return [{ affectedRows: Number(removed) }, []];
    }
    if (sql.startsWith("SELECT id, email, name, password_hash")) {
      const account = mocks.accounts.find(row => row.email === params[0]);
      return [account ? [account] : [], []];
    }
    if (sql.startsWith("UPDATE geotwin_accounts")) return [{ affectedRows: 1 }, []];
    if (sql.startsWith("SELECT a.id, a.email, a.name")) {
      const accountId = mocks.sessions.get(String(params[0]));
      const account = mocks.accounts.find(row => row.id === accountId);
      return [account ? [{ id: account.id, email: account.email, name: account.name, created_at: account.created_at, last_signed_in: account.last_signed_in }] : [], []];
    }
    throw new Error(`Unmocked account SQL: ${sql}`);
  });
}

describe("GeoTwinAI first-party account access", () => {
  it("normalizes emails and stores password verifiers rather than plaintext passwords", async () => {
    expect(normalizeAccountEmail("  City.Planner@Example.COM  ")).toBe("city.planner@example.com");
    expect(normalizeAccountEmail("not-an-email")).toBeNull();
    const password = "A long city-planning passphrase 2026";
    const verifier = await hashAccountPassword(password);
    expect(verifier).toMatch(/^scrypt\$/);
    expect(verifier).not.toContain(password);
    expect(await verifyAccountPassword(password, verifier)).toBe(true);
    expect(await verifyAccountPassword("not the password", verifier)).toBe(false);
  });

  it("requires CSRF protection and explicit terms acceptance before creating an account", async () => {
    await withAuthServer(async baseUrl => {
      const csrfResponse = await fetch(`${baseUrl}/api/geotwin/auth/csrf`, { headers: { "x-forwarded-proto": "https" } });
      expect(csrfResponse.status).toBe(200);
      const token = (await csrfResponse.json() as { csrfToken: string }).csrfToken;
      expect(cookieValue(csrfResponse.headers.get("set-cookie"), GEO_TWIN_CSRF_COOKIE)).toBe(token);
      expect(csrfResponse.headers.get("set-cookie")).toContain("Secure");
      const withoutCsrf = await fetch(`${baseUrl}/api/geotwin/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(withoutCsrf.status).toBe(403);
      const withoutTerms = await fetch(`${baseUrl}/api/geotwin/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${GEO_TWIN_CSRF_COOKIE}=${token}`, [GEO_TWIN_CSRF_HEADER]: token, "x-forwarded-proto": "https" },
        body: JSON.stringify({ name: "Test Account", email: "planner@example.com", password: "A strong password with 12 characters" }),
      });
      expect(withoutTerms.status).toBe(400);
      expect(await withoutTerms.json()).toMatchObject({ error: "Accept the Terms & Conditions to create an account." });
      expect(mocks.execute).not.toHaveBeenCalled();
    });
  });

  it("creates a read-only account, persists an opaque session and revokes it on logout", async () => {
    mockPersistentDatabase();
    await withAuthServer(async baseUrl => {
      const csrfResponse = await fetch(`${baseUrl}/api/geotwin/auth/csrf`, { headers: { "x-forwarded-proto": "https" } });
      const csrfToken = (await csrfResponse.json() as { csrfToken: string }).csrfToken;
      const csrfCookie = `${GEO_TWIN_CSRF_COOKIE}=${csrfToken}`;
      const headers = { "content-type": "application/json", cookie: csrfCookie, [GEO_TWIN_CSRF_HEADER]: csrfToken, "x-forwarded-proto": "https" };
      const password = "This is a strong planning passphrase";
      const registration = await fetch(`${baseUrl}/api/geotwin/auth/register`, {
        method: "POST", headers,
        body: JSON.stringify({ name: "Nagpur Planner", email: "planner@example.com", password, acceptedTerms: true }),
      });
      expect(registration.status).toBe(201);
      const registrationBody = await registration.json() as { user: { accountId: number; email: string; role: string }; termsVersion: string };
      expect(registrationBody).toMatchObject({ user: { accountId: 1, email: "planner@example.com", role: "user" }, termsVersion: GEO_TWIN_TERMS_VERSION });
      expect(JSON.stringify(registrationBody)).not.toContain(password);
      expect(mocks.accounts[0]).toMatchObject({ terms_version: GEO_TWIN_TERMS_VERSION });
      const storedHash = String(mocks.accounts[0].password_hash);
      expect(storedHash).not.toContain(password);

      const login = await fetch(`${baseUrl}/api/geotwin/auth/login`, { method: "POST", headers, body: JSON.stringify({ email: "PLANNER@example.com", password }) });
      expect(login.status).toBe(200);
      const loginBody = await login.json() as { user: { accountId: number; role: string } };
      expect(loginBody.user).toMatchObject({ accountId: 1, role: "user" });
      const sessionToken = cookieValue(login.headers.get("set-cookie"), GEO_TWIN_SESSION_COOKIE);
      expect(sessionToken).toHaveLength(43);
      expect(sessionToken).not.toBe(storedHash);
      expect(Array.from(mocks.sessions.keys())[0]).not.toBe(sessionToken);

      const cookie = `${csrfCookie}; ${GEO_TWIN_SESSION_COOKIE}=${sessionToken}`;
      const me = await fetch(`${baseUrl}/api/geotwin/auth/me`, { headers: { cookie, "x-forwarded-proto": "https" } });
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({ user: { accountId: 1, email: "planner@example.com", role: "user" } });

      const logout = await fetch(`${baseUrl}/api/geotwin/auth/logout`, { method: "POST", headers: { ...headers, cookie }, body: JSON.stringify({}) });
      expect(logout.status).toBe(200);
      expect(await logout.json()).toEqual({ success: true });
      const afterLogout = await fetch(`${baseUrl}/api/geotwin/auth/me`, { headers: { cookie, "x-forwarded-proto": "https" } });
      expect(await afterLogout.json()).toEqual({ user: null });
    });
  });
});
