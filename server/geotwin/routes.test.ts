import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), getPool: vi.fn() }));

vi.mock("./auth", () => ({
  geoTwinSessionMiddleware: (req: unknown, res: import("express").Response, next: import("express").NextFunction) => {
    void mocks.authenticate(req).then((user: unknown) => { res.locals.geotwinUser = user; next(); }).catch(() => res.status(401).json({ error: "No session" }));
  },
  geoTwinCsrfMiddleware: (_req: unknown, _res: unknown, next: import("express").NextFunction) => next(),
}));
vi.mock("./database", () => ({
  getPool: mocks.getPool,
  parseJson: (value: unknown, fallback: unknown) => {
    if (typeof value !== "string") return value ?? fallback;
    try { return JSON.parse(value); } catch { return fallback; }
  },
}));

import { registerGeoTwinRoutes } from "./routes";

afterEach(() => vi.resetAllMocks());

describe("GeoTwinAI internal map feature endpoint", () => {
  it("returns source-backed geometry and attributes for a bounded authenticated request", async () => {
    const road = {
      id: 17,
      category: "Roads",
      region: "Central",
      name: "Sample road segment",
      latitude: 21.1458,
      longitude: 79.0882,
      geometry_type: "LineString",
      geometry: "LINESTRING (79.087 21.145, 79.089 21.146)",
      properties: JSON.stringify({ highway: "residential", surface: "paved" }),
      dataset: "Nagpur roads",
      sourceFile: "Nagpur_Roads_Clean.csv",
    };
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT DISTINCT f.category")) return [[{ category: "Roads" }], []];
      if (sql.startsWith("SELECT COUNT(*) AS count")) return [[{ count: 1 }], []];
      return [[road], []];
    });
    const pool = { execute };
    mocks.getPool.mockReturnValue(pool);
    mocks.authenticate.mockResolvedValue({ openId: "test-viewer", name: "Map test", role: "user", isCron: false });

    const app = express();
    registerGeoTwinRoutes(app);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const { port } = server.address() as { port: number };
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/geotwin/features?categories=Roads&region=Central&west=79.04&east=79.15&south=21.10&north=21.20`);
      expect(response.status).toBe(200);
      const body = await response.json() as { features: { geometry: string; latitude: number; longitude: number; sourceFile: string; properties: Record<string, unknown> }[]; count: number; availableCategories: string[] };
      expect(body.count).toBe(1);
      expect(body.availableCategories).toContain("Roads");
      expect(body.features).toHaveLength(1);
      expect(body.features[0]).toMatchObject({ geometry: road.geometry, latitude: 21.1458, longitude: 79.0882, sourceFile: road.sourceFile, properties: { highway: "residential", surface: "paved" } });
      expect(execute).toHaveBeenCalledTimes(3);
      expect(execute.mock.calls.some(([sql]) => sql.includes("f.longitude BETWEEN ? AND ?") && sql.includes("f.region=?"))).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("fails closed when a private map request has no authenticated session", async () => {
    const execute = vi.fn();
    mocks.getPool.mockReturnValue({ execute });
    mocks.authenticate.mockRejectedValue(new Error("No session"));
    const app = express();
    registerGeoTwinRoutes(app);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const { port } = server.address() as { port: number };
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/geotwin/features?categories=Roads`);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "No session" });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("returns buildings, hospitals and schools as separate selectable map layers", async () => {
    const requested = ["Buildings", "Hospitals", "Schools"];
    const rowFor = (category: string) => ({
      id: requested.indexOf(category) + 1,
      category,
      region: "Central",
      name: `Sample ${category.toLowerCase()}`,
      latitude: 21.1458,
      longitude: 79.0882,
      geometry_type: "Point",
      geometry: "POINT (79.0882 21.1458)",
      properties: JSON.stringify({ source: `${category}.csv` }),
      dataset: `Nagpur ${category}`,
      sourceFile: `${category}.csv`,
    });
    const execute = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("SELECT DISTINCT f.category")) return [[...requested.map(category => ({ category }))], []];
      if (sql.startsWith("SELECT COUNT(*) AS count")) return [[{ count: 1 }], []];
      return [[rowFor(String(params[0]))], []];
    });
    mocks.getPool.mockReturnValue({ execute });
    mocks.authenticate.mockResolvedValue({ openId: "test-viewer", name: "Map test", role: "user", isCron: false });

    const app = express();
    registerGeoTwinRoutes(app);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const { port } = server.address() as { port: number };
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/geotwin/features?categories=${requested.join(",")}&west=79.04&east=79.15&south=21.10&north=21.20`);
      expect(response.status).toBe(200);
      const body = await response.json() as { features: { category: string; geometry: string }[]; availableCategories: string[] };
      expect(body.availableCategories).toEqual(expect.arrayContaining(requested));
      expect(body.features.map(feature => feature.category)).toEqual(requested);
      expect(body.features.every(feature => feature.geometry.startsWith("POINT"))).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each(["North", "South", "East", "West", "Central"]) ("returns a full feature extent for the selected %s region", async region => {
    const extent = { west: 79.01, east: 79.12, south: 21.08, north: 21.22 };
    const execute = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("SELECT MIN(f.longitude) AS west")) return [[extent], []];
      if (sql.includes("SELECT DISTINCT f.category")) return [[{ category: "Buildings" }, { category: "Roads" }], []];
      if (sql.startsWith("SELECT COUNT(*) AS count")) return [[{ count: 1 }], []];
      const category = String(params[0]);
      return [[{ id: 1, category, region, name: `Sample ${category}`, latitude: 21.15, longitude: 79.08, geometry_type: "Point", geometry: "POINT (79.08 21.15)", properties: "{}", dataset: `Nagpur ${category}`, sourceFile: `${category}.csv` }], []];
    });
    mocks.getPool.mockReturnValue({ execute });
    mocks.authenticate.mockResolvedValue({ openId: "test-viewer", name: "Map test", role: "user", isCron: false });

    const app = express();
    registerGeoTwinRoutes(app);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const { port } = server.address() as { port: number };
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/geotwin/features?categories=Buildings,Roads&region=${region}&fitRegion=1`);
      expect(response.status).toBe(200);
      const body = await response.json() as { features: { region: string }[]; extent: typeof extent };
      expect(body.extent).toEqual(extent);
      expect(body.features.length).toBeGreaterThan(0);
      expect(body.features.every(feature => feature.region === region)).toBe(true);
      const extentQuery = execute.mock.calls.find(([sql]) => sql.includes("SELECT MIN(f.longitude) AS west"));
      expect(extentQuery?.[1]).toContain(region);
      expect(extentQuery?.[0]).not.toContain("f.longitude BETWEEN ? AND ?");
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
