import { createHash, randomUUID } from "node:crypto";
import { createReadStream, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import multer from "multer";
import { parse as parseCsv } from "csv-parse";
import { getPool, parseJson } from "./database";
import { invokeLLM } from "../_core/llm";
import { geoTwinCsrfMiddleware, geoTwinSessionMiddleware, type GeoTwinPrincipal } from "./auth";
import { ENV } from "../_core/env";
import { ALL_CATEGORIES, ANALYTICAL_REGIONS, CORE_CATEGORIES, findColumn, identifyCategory, isValidWgs84, normalizeKey, numberOrNull, parseWktPoint, safeName, type Category } from "./shared";
import type { RowDataPacket } from "mysql2/promise";

const uploadDirectory = mkdtempSync(path.join(tmpdir(), "geotwinai-import-"));
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadDirectory),
    filename: (_req, file, callback) => callback(null, `${randomUUID()}-${path.basename(file.originalname).replace(/[^\w.\-]/g, "_")}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 12 },
  fileFilter: (_req, file, callback) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (![".csv", ".geojson", ".json"].includes(ext)) return callback(new Error("Supported uploads are CSV and GeoJSON. GeoPackage is not accepted in this build; export it to GeoJSON first."));
    callback(null, true);
  },
});
const asyncRoute = (handler: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
  void handler(req, res).catch(error => {
    console.error("[GeoTwinAI API]", error);
    if (!res.headersSent) res.status(500).json({ error: "The request could not be completed. Check database readiness and the import or query details." });
  });
};
const removeFile = (file?: Express.Multer.File) => { if (file?.path) { try { rmSync(file.path, { force: true }); } catch {} } };
const featureDigest = (category: string, props: Record<string, unknown>, geometry: string) => createHash("sha256").update(`${category}\u0000${geometry}\u0000${JSON.stringify(props)}`).digest("hex");
const jsonString = (value: unknown) => JSON.stringify(value ?? {});
const parseWktType = (text: string) => (text.match(/^\s*(MULTIPOLYGON|POLYGON|MULTILINESTRING|LINESTRING|MULTIPOINT|POINT)\b/i)?.[1] ?? "").toLowerCase();
const isAdministrativeRegion = (value: string | null) => !!value && ANALYTICAL_REGIONS.includes(value as (typeof ANALYTICAL_REGIONS)[number]);

function getDatabase() {
  const pool = getPool();
  if (!pool) throw new Error("Managed database is not configured");
  return pool;
}

function signedInUser(res: Response): GeoTwinPrincipal | null {
  return (res.locals.geotwinUser as GeoTwinPrincipal | undefined) ?? null;
}

function isProjectOwner(res: Response): boolean {
  const user = signedInUser(res);
  const ownerId = Number(ENV.ownerAccountId);
  const ownerEmail = ENV.ownerEmail.trim().toLowerCase();
  return Boolean(user && ownerEmail && ENV.ownerAccountId.trim() && Number.isSafeInteger(ownerId) && ownerId > 0 && user.accountId === ownerId && user.email.toLowerCase() === ownerEmail && user.role === "admin");
}

const ownerOnly: RequestHandler = (_req, res, next) => {
  if (!isProjectOwner(res)) {
    const ownerConfigured = Boolean(ENV.ownerAccountId.trim() && ENV.ownerEmail.trim());
    return res.status(403).json({ error: ownerConfigured ? "Only the account bound as project owner can change shared datasets." : "Dataset changes are locked until a project owner account is bound in protected project settings." });
  }
  return next();
};

function accountConversationId(rawId: string, user: GeoTwinPrincipal): string {
  return createHash("sha256").update(`${user.openId}\u0000${rawId}`).digest("hex");
}

async function contentDigest(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function parseGeoJsonRows(filePath: string) {
  const document = JSON.parse(readFileSync(filePath, "utf8"));
  const features = document?.type === "FeatureCollection" ? document.features : document?.type === "Feature" ? [document] : null;
  if (!Array.isArray(features)) throw new Error("GeoJSON must be a Feature or FeatureCollection.");
  return features as { type: string; properties?: Record<string, unknown> | null; geometry?: { type?: string; coordinates?: unknown } | null }[];
}

async function sampleCsv(filePath: string, maxRows = 12) {
  const parser = createReadStream(filePath).pipe(parseCsv({ bom: true, columns: true, skip_empty_lines: true, relax_column_count: true, trim: true, to: maxRows }));
  const rows: Record<string, string>[] = [];
  for await (const row of parser as AsyncIterable<Record<string, string>>) rows.push(row);
  return { headers: rows[0] ? Object.keys(rows[0]) : [], rows };
}

function coordinatesFromGeometry(value: string) {
  const point = parseWktPoint(value);
  if (point) return point;
  try {
    const parsed = JSON.parse(value) as { type?: string; coordinates?: unknown };
    if (parsed.type && parsed.coordinates) return coordinateAnchor(parsed.coordinates);
  } catch {}
  return null;
}

function coordinateAnchor(input: unknown): { longitude: number; latitude: number } | null {
  const pairs: number[][] = [];
  const visit = (value: unknown) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") pairs.push([value[0], value[1]]);
    else value.forEach(visit);
  };
  visit(input);
  if (!pairs.length) return null;
  const sum = pairs.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]);
  return { longitude: sum[0] / pairs.length, latitude: sum[1] / pairs.length };
}

function normalizeImportedRow(row: Record<string, unknown>, headers: string[], category: Category, isGeoJson = false) {
  const latKey = findColumn(headers, "lat");
  const lonKey = findColumn(headers, "lon");
  const regionKey = findColumn(headers, "region");
  const geomKey = findColumn(headers, "geometry");
  let latitude = numberOrNull(latKey ? row[latKey] : null);
  let longitude = numberOrNull(lonKey ? row[lonKey] : null);
  let geometry = geomKey ? String(row[geomKey] ?? "").trim() : "";
  let geometryType = parseWktType(geometry);
  if ((!isValidWgs84(latitude, longitude)) && geometry) {
    const anchor = coordinatesFromGeometry(geometry);
    if (anchor && isValidWgs84(anchor.latitude, anchor.longitude)) {
      latitude = anchor.latitude;
      longitude = anchor.longitude;
    }
  }
  if (isGeoJson && row.__geoGeometry && typeof row.__geoGeometry === "object") {
    const geo = row.__geoGeometry as { type?: string; coordinates?: unknown };
    geometryType = (geo.type ?? "").toLowerCase();
    geometry = jsonString(geo);
    const anchor = coordinateAnchor(geo.coordinates);
    if (anchor && isValidWgs84(anchor.latitude, anchor.longitude)) {
      latitude = anchor.latitude;
      longitude = anchor.longitude;
    }
  }
  const normalized = Object.fromEntries(Object.entries(row).filter(([key]) => key !== "__geoGeometry"));
  const region = regionKey && String(row[regionKey] ?? "").trim() ? String(row[regionKey]).trim().slice(0, 64) : null;
  return { category, region, latitude, longitude, geometryType, geometry, properties: normalized, name: safeName(normalized) };
}

async function writeFeatures(pool: ReturnType<typeof getDatabase>, datasetId: number, category: string, rows: ReturnType<typeof normalizeImportedRow>[]) {
  if (!rows.length) return 0;
  const createdAt = new Date();
  const values = rows.map(row => [datasetId, category, row.region, featureDigest(category, row.properties, row.geometry), row.name, isValidWgs84(row.latitude, row.longitude) ? row.latitude : null, isValidWgs84(row.latitude, row.longitude) ? row.longitude : null, row.geometryType || null, row.geometry || null, jsonString(row.properties), createdAt]);
  const placeholder = "(?,?,?,?,?,?,?,?,?,?,?)";
  const [result] = await pool.execute(`INSERT IGNORE INTO geotwin_features (dataset_id, category, region, feature_hash, name, latitude, longitude, geometry_type, geometry, properties, created_at) VALUES ${values.map(() => placeholder).join(",")}`, values.flat() as never[]);
  return Number((result as { affectedRows?: number }).affectedRows ?? 0);
}

async function readJsonFile(file: Express.Multer.File) {
  const parsed = parseGeoJsonRows(file.path);
  if (parsed.length > 200000) throw new Error("This GeoJSON exceeds the 200,000-feature limit for one import. Split it into smaller files.");
  return parsed;
}

export function registerGeoTwinRoutes(app: Express) {
  app.use("/api/geotwin", geoTwinSessionMiddleware, geoTwinCsrfMiddleware);

  app.get("/api/geotwin/status", asyncRoute(async (_req, res) => {
    const pool = getPool();
    const aiConfigured = Boolean(ENV.forgeApiUrl.trim() && ENV.forgeApiKey.trim());
    const canManage = isProjectOwner(res);
    const ownerSetupRequired = !ENV.ownerAccountId.trim() || !ENV.ownerEmail.trim();
    if (!pool) return res.status(503).json({ database: false, seeded: false, aiConfigured, canManage, ownerSetupRequired, message: "The managed database connection is not configured." });
    try {
      const [[datasetCount]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM geotwin_datasets WHERE status='ready'");
      const [[featureCount]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM geotwin_features");
      const [[seedReady]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM geotwin_datasets WHERE source_type='seed' AND status='ready'");
      const expectedSeedDatasets = 10;
      return res.json({ database: true, seeded: Number(seedReady?.count) >= expectedSeedDatasets, datasets: Number(datasetCount?.count ?? 0), records: Number(featureCount?.count ?? 0), initializing: Number(seedReady?.count ?? 0) < expectedSeedDatasets, aiConfigured, canManage, ownerSetupRequired });
    } catch (error) {
      console.warn("[GeoTwinAI] Database tables not ready yet", error);
      return res.status(503).json({ database: true, seeded: false, initializing: true, canManage, ownerSetupRequired, message: "The data tables are being prepared. Refresh in a moment." });
    }
  }));

  app.get("/api/geotwin/summary", asyncRoute(async (_req, res) => {
    const pool = getDatabase();
    const [datasetRows] = await pool.query<RowDataPacket[]>("SELECT id, dataset_key, display_name, category, source_file, source_type, status, active, total_records, mapped_records, invalid_coordinates, metadata, imported_at FROM geotwin_datasets ORDER BY category, display_name");
    const [counts] = await pool.query<RowDataPacket[]>("SELECT f.category, COUNT(*) AS records, SUM(f.latitude IS NOT NULL AND f.longitude IS NOT NULL) AS mapped FROM geotwin_features f INNER JOIN geotwin_datasets d ON f.dataset_id=d.id WHERE d.active=1 AND d.status='ready' GROUP BY f.category");
    const [regional] = await pool.query<RowDataPacket[]>("SELECT f.region, f.category, COUNT(*) AS records FROM geotwin_features f INNER JOIN geotwin_datasets d ON f.dataset_id=d.id WHERE d.active=1 AND d.status='ready' AND f.latitude IS NOT NULL AND f.longitude IS NOT NULL AND f.category IN ('Buildings','Roads','Hospitals','Schools','Parks','Water bodies') AND f.region IN ('North','South','East','West','Central') GROUP BY f.region,f.category ORDER BY f.region,f.category");
    const [metricRows] = await pool.query<RowDataPacket[]>("SELECT metric_key, source_file, payload FROM geotwin_metrics ORDER BY source_file, id");
    const [quality] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS total, SUM(f.latitude IS NOT NULL AND f.longitude IS NOT NULL) AS mapped, COUNT(DISTINCT f.dataset_id) AS datasets FROM geotwin_features f INNER JOIN geotwin_datasets d ON f.dataset_id=d.id WHERE d.active=1 AND d.status='ready'");
    const groupedCounts = Object.fromEntries(counts.map(row => [String(row.category), { records: Number(row.records), mapped: Number(row.mapped) }]));
    const regionCounts = Object.fromEntries(ANALYTICAL_REGIONS.map(region => [region, Object.fromEntries(CORE_CATEGORIES.map(category => [category, 0]))]));
    for (const row of regional) if (regionCounts[String(row.region)]) regionCounts[String(row.region)][String(row.category)] = Number(row.records);
    const metrics = metricRows.map(row => ({ key: row.metric_key, source: row.source_file, value: parseJson(row.payload, {}) }));
    const datasets = datasetRows.map(row => ({ id: Number(row.id), key: row.dataset_key, name: row.display_name, category: row.category, source: row.source_file, sourceType: row.source_type, status: row.status, active: Boolean(row.active), records: Number(row.total_records), mappedRecords: Number(row.mapped_records), invalidCoordinates: Number(row.invalid_coordinates), metadata: parseJson(row.metadata, {}), importedAt: row.imported_at }));
    return res.json({ center: { latitude: 21.1458, longitude: 79.0882 }, regions: ANALYTICAL_REGIONS, coreCategories: CORE_CATEGORIES, categories: ALL_CATEGORIES, datasets, counts: groupedCounts, regionalCounts: regionCounts, metrics, quality: { total: Number(quality[0]?.total ?? 0), mapped: Number(quality[0]?.mapped ?? 0), datasets: Number(quality[0]?.datasets ?? 0) }, provenance: "Supplied cleaned GeoTwinAI archive and subsequent explicit user imports. Region labels are analytical only; city-wide environmental records are not redistributed across regions." });
  }));

  app.get("/api/geotwin/features", asyncRoute(async (req, res) => {
    const pool = getDatabase();
    const categoryValues = String(req.query.categories ?? "").split(",").map(s => s.trim()).filter(s => ALL_CATEGORIES.includes(s as Category));
    if (!categoryValues.length) return res.json({ features: [], count: 0, loaded: 0, availableCategories: [], note: "Select at least one available category." });
    const region = String(req.query.region ?? "");
    const search = String(req.query.search ?? "").trim().slice(0, 120);
    const west = numberOrNull(req.query.west), east = numberOrNull(req.query.east), south = numberOrNull(req.query.south), north = numberOrNull(req.query.north);
    const bounded = [west, east, south, north].every(v => v !== null) && west! < east! && south! < north! && Math.abs(west!) <= 180 && Math.abs(east!) <= 180 && Math.abs(south!) <= 90 && Math.abs(north!) <= 90;
    const categoryResults = await Promise.all(categoryValues.map(async category => {
      const where = ["f.category=?", "d.active=1", "d.status='ready'", "f.latitude IS NOT NULL", "f.longitude IS NOT NULL"];
      const params: (string | number)[] = [category];
      if (region && isAdministrativeRegion(region)) {
        if (["Built-up", "Green cover", "Flood risk", "NDVI"].includes(category)) { where.push("(f.region=? OR f.region='Nagpur' OR f.region IS NULL)"); params.push(region); }
        else { where.push("f.region=?"); params.push(region); }
      }
      if (search) { where.push("(f.name LIKE ? OR f.category LIKE ? OR f.properties LIKE ?)"); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
      if (bounded) { where.push("f.longitude BETWEEN ? AND ?", "f.latitude BETWEEN ? AND ?"); params.push(west!, east!, south!, north!); }
      const limit = category === "Roads" ? 850 : ["Green cover", "Built-up", "Flood risk", "NDVI"].includes(category) ? 900 : 650;
      const [[countRow]] = await pool.execute<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM geotwin_features f INNER JOIN geotwin_datasets d ON d.id=f.dataset_id WHERE ${where.join(" AND ")}`, params);
      const [rows] = await pool.execute<RowDataPacket[]>(`SELECT f.id, f.category, f.region, f.name, f.latitude, f.longitude, f.geometry_type, f.geometry, f.properties, d.display_name AS dataset, d.source_file AS sourceFile FROM geotwin_features f INNER JOIN geotwin_datasets d ON d.id=f.dataset_id WHERE ${where.join(" AND ")} ORDER BY f.id LIMIT ${limit}`, params);
      return { rows, total: Number(countRow?.count ?? 0) };
    }));
    const fitRegion = req.query.fitRegion === "1";
    let extent: { west: number; east: number; south: number; north: number } | null | undefined;
    if (fitRegion) {
      const environmental = new Set(["Built-up", "Green cover", "Flood risk", "NDVI"]);
      const regionCategories = categoryValues.filter(category => !environmental.has(category));
      const extentCategories = regionCategories.length ? regionCategories : categoryValues;
      const extentWhere = ["d.active=1", "d.status='ready'", "f.latitude IS NOT NULL", "f.longitude IS NOT NULL", `f.category IN (${extentCategories.map(() => "?").join(",")})`];
      const extentParams: (string | number)[] = [...extentCategories];
      if (region && isAdministrativeRegion(region)) {
        const regional = extentCategories.filter(category => !environmental.has(category));
        const citywide = extentCategories.filter(category => environmental.has(category));
        const clauses: string[] = [];
        if (regional.length) {
          clauses.push(`(f.category IN (${regional.map(() => "?").join(",")}) AND f.region=?)`);
          extentParams.push(...regional, region);
        }
        if (citywide.length) {
          clauses.push(`(f.category IN (${citywide.map(() => "?").join(",")}) AND (f.region=? OR f.region='Nagpur' OR f.region IS NULL))`);
          extentParams.push(...citywide, region);
        }
        extentWhere.push(`(${clauses.join(" OR ")})`);
      }
      if (search) { extentWhere.push("(f.name LIKE ? OR f.category LIKE ? OR f.properties LIKE ?)"); extentParams.push(`%${search}%`, `%${search}%`, `%${search}%`); }
      const [extentRows] = await pool.execute<RowDataPacket[]>(`SELECT MIN(f.longitude) AS west, MAX(f.longitude) AS east, MIN(f.latitude) AS south, MAX(f.latitude) AS north FROM geotwin_features f INNER JOIN geotwin_datasets d ON d.id=f.dataset_id WHERE ${extentWhere.join(" AND ")}`, extentParams);
      const row = extentRows[0];
      extent = row && [row.west, row.east, row.south, row.north].every(value => value !== null && value !== undefined && Number.isFinite(Number(value)))
        ? { west: Number(row.west), east: Number(row.east), south: Number(row.south), north: Number(row.north) }
        : null;
    }
    const [catalog] = await pool.execute<RowDataPacket[]>(`SELECT DISTINCT f.category FROM geotwin_features f INNER JOIN geotwin_datasets d ON d.id=f.dataset_id WHERE d.active=1 AND d.status='ready' AND f.latitude IS NOT NULL AND f.longitude IS NOT NULL AND f.category IN (${ALL_CATEGORIES.map(()=>"?").join(",")})`, ALL_CATEGORIES);
    const availableCategories = catalog.map(row => String(row.category));
    const all = categoryResults.flatMap(group => group.rows.map(row => ({ id: Number(row.id), category: row.category, region: row.region, name: row.name, latitude: Number(row.latitude), longitude: Number(row.longitude), geometryType: row.geometry_type, geometry: row.geometry, properties: parseJson(row.properties, {}), dataset: row.dataset, sourceFile: row.sourceFile })));
    const total = categoryResults.reduce((sum, group) => sum + group.total, 0);
    return res.json({ features: all, count: total, loaded: all.length, truncated: total > all.length, availableCategories, ...(fitRegion ? { extent } : {}) });
  }));

  app.get("/api/geotwin/datasets", asyncRoute(async (_req, res) => {
    const pool = getDatabase();
    const [datasets] = await pool.query<RowDataPacket[]>("SELECT d.id, d.dataset_key AS `key`, d.display_name AS name, d.category, d.source_file AS source, d.source_type AS sourceType, d.status, d.active, d.total_records AS records, d.mapped_records AS mappedRecords, d.invalid_coordinates AS invalidCoordinates, d.metadata, d.imported_at AS importedAt, (SELECT COUNT(*) FROM geotwin_features f WHERE f.dataset_id=d.id) AS storedRecords FROM geotwin_datasets d ORDER BY d.created_at DESC");
    const [imports] = await pool.query<RowDataPacket[]>("SELECT i.id, i.dataset_id AS datasetId, i.source_file AS source, i.category, i.status, i.records_read AS recordsRead, i.records_imported AS recordsImported, i.invalid_coordinates AS invalidCoordinates, i.duplicate_records AS duplicateRecords, i.details, i.started_at AS startedAt, i.completed_at AS completedAt FROM geotwin_imports i ORDER BY i.id DESC LIMIT 100");
    return res.json({ datasets: datasets.map(d => ({ ...d, active: Boolean(d.active), metadata: parseJson(d.metadata, {}) })), imports: imports.map(i => ({ ...i, details: parseJson(i.details, {}) })) });
  }));

  app.patch("/api/geotwin/datasets/:id", ownerOnly, asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0 || typeof req.body?.active !== "boolean") return res.status(400).json({ error: "Provide a valid dataset id and active boolean." });
    const pool = getDatabase();
    const [result] = await pool.execute("UPDATE geotwin_datasets SET active=? WHERE id=? AND status='ready'", [req.body.active ? 1 : 0, id]);
    if (Number((result as { affectedRows?: number }).affectedRows) === 0) return res.status(404).json({ error: "Dataset not found or not ready." });
    return res.json({ success: true });
  }));

  app.delete("/api/geotwin/datasets/:id", ownerOnly, asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0 || req.query.confirm !== "delete") return res.status(400).json({ error: "Explicit confirmation is required before deleting a dataset." });
    const pool = getDatabase();
    const [result] = await pool.execute("DELETE FROM geotwin_datasets WHERE id=? AND source_type='upload'", [id]);
    if (Number((result as { affectedRows?: number }).affectedRows) === 0) return res.status(404).json({ error: "Uploaded dataset not found. Supplied seed data cannot be deleted here." });
    return res.json({ success: true });
  }));

  app.get("/api/geotwin/imports/:id", asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const [rows] = await getDatabase().execute<RowDataPacket[]>("SELECT id, status, records_read AS recordsRead, records_imported AS recordsImported, invalid_coordinates AS invalidCoordinates, duplicate_records AS duplicateRecords, details, completed_at AS completedAt FROM geotwin_imports WHERE id=?", [id]);
    if (!rows.length) return res.status(404).json({ error: "Import activity not found." });
    return res.json({ ...rows[0], details: parseJson(rows[0].details, {}) });
  }));

  app.post("/api/geotwin/upload-preview", ownerOnly, upload.single("file"), asyncRoute(async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Choose a CSV or GeoJSON file." });
    try {
      const category = identifyCategory(String(req.body.category ?? ""), file.originalname);
      const hash = await contentDigest(file.path);
      const geoJson = /\.(geojson|json)$/i.test(file.originalname);
      const sample = geoJson ? parseGeoJsonRows(file.path).slice(0, 12).map(item => ({ ...(item.properties ?? {}), __geoGeometry: item.geometry })) : (await sampleCsv(file.path)).rows;
      const headers = geoJson ? Object.keys(sample[0] ?? {}).filter(k => k !== "__geoGeometry") : sample[0] ? Object.keys(sample[0]) : [];
      const normalized = sample.map(row => normalizeImportedRow(row, Object.keys(row), category, geoJson));
      const mapped = normalized.filter(row => isValidWgs84(row.latitude, row.longitude)).length;
      const detectedGeom = geoJson ? String((sample[0] as Record<string, unknown> | undefined)?.__geoGeometry ? ((sample[0] as Record<string, unknown>).__geoGeometry as { type?: string }).type : "GeoJSON") : findColumn(headers, "geometry") ?? (headers.length ? "coordinate columns" : "unknown");
      const [hist] = await getDatabase().execute("INSERT INTO geotwin_imports (source_file, category, status, records_read, records_imported, invalid_coordinates, duplicate_records, details) VALUES (?, ?, 'previewed', 0, 0, 0, 0, ?)", [file.originalname, category, JSON.stringify({ sha256: hash, size: file.size, format: geoJson ? "GeoJSON" : "CSV", coordinateColumns: { latitude: findColumn(headers, "lat"), longitude: findColumn(headers, "lon") }, geometryField: detectedGeom, previewRows: normalized.length })]);
      return res.json({ previewId: Number((hist as { insertId?: number }).insertId), fileName: file.originalname, bytes: file.size, format: geoJson ? "GeoJSON" : "CSV", category, headers, preview: sample.map(row => Object.fromEntries(Object.entries(row).filter(([k]) => k !== "__geoGeometry"))).slice(0, 8), sampleCount: sample.length, spatiallyLocatedSample: mapped, geometryDetected: detectedGeom, coordinateColumns: { latitude: findColumn(headers, "lat"), longitude: findColumn(headers, "lon") }, crs: geoJson ? "GeoJSON coordinates are interpreted as WGS84 longitude/latitude." : mapped ? "Sample coordinates fall within geographic WGS84 ranges; confirm the source CRS before import." : "No usable WGS84 coordinate pair was identified.", needsCrsConfirmation: !geoJson, sourceHash: hash, limitations: "Preview scans a small sample; full validation and row counts are recorded during import." });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "The file could not be previewed." });
    } finally { removeFile(file); }
  }));

  app.post("/api/geotwin/import", ownerOnly, upload.single("file"), asyncRoute(async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Choose the previewed source file again to confirm import." });
    let importId = Number(req.body.previewId);
    let datasetId: number | null = null;
    try {
      if (req.body.confirm !== "yes") return res.status(400).json({ error: "Explicit import confirmation is required." });
      const pool = getDatabase();
      const [histRows] = await pool.execute<RowDataPacket[]>("SELECT id, source_file, category, status, details FROM geotwin_imports WHERE id=?", [importId]);
      if (!histRows.length || histRows[0].status !== "previewed") return res.status(400).json({ error: "The preview has expired. Preview the file again." });
      const preview = parseJson(histRows[0].details, {}) as { sha256?: string };
      const actualHash = await contentDigest(file.path);
      if (!preview.sha256 || actualHash !== preview.sha256) return res.status(400).json({ error: "The file changed after preview. Please preview it again before importing." });
      const category = String(req.body.category || histRows[0].category);
      if (!ALL_CATEGORIES.includes(category as Category)) return res.status(400).json({ error: "Select a supported dataset category." });
      const geoJson = /\.(geojson|json)$/i.test(file.originalname);
      if (!geoJson && req.body.crsConfirmed !== "yes") return res.status(400).json({ error: "Confirm the input coordinate reference system. Use WGS84 latitude/longitude only when the source file uses geographic coordinates." });
      const datasetName = String(req.body.datasetName || path.basename(file.originalname, path.extname(file.originalname))).trim().slice(0, 255) || "Uploaded dataset";
      const datasetKey = `upload-${randomUUID()}`;
      const [created] = await pool.execute("INSERT INTO geotwin_datasets (dataset_key, display_name, category, source_file, source_type, status, active, total_records, mapped_records, invalid_coordinates, metadata, source_hash) VALUES (?, ?, ?, ?, 'upload', 'processing', 1, 0, 0, 0, ?, ?)", [datasetKey, datasetName, category, file.originalname, JSON.stringify({ format: geoJson ? "GeoJSON" : "CSV", crs: geoJson ? "RFC 7946/WGS84" : "User-confirmed WGS84 longitude/latitude", importedAt: new Date().toISOString() }), actualHash]);
      datasetId = Number((created as { insertId?: number }).insertId);
      await pool.execute("UPDATE geotwin_imports SET dataset_id=?, source_file=?, category=?, status='processing', details=? WHERE id=?", [datasetId, file.originalname, category, JSON.stringify({ sha256: actualHash, datasetName }), importId]);
      let recordsRead = 0, recordsImported = 0, invalidCoordinates = 0, duplicates = 0;
      let rows: ReturnType<typeof normalizeImportedRow>[] = [];
      let seen = new Set<string>();
      const flush = async () => {
        if (!rows.length) return;
        const payload = rows.filter(item => {
          const hash = featureDigest(category, item.properties, item.geometry);
          if (seen.has(hash)) { duplicates++; return false; }
          seen.add(hash); return true;
        });
        if (payload.length) recordsImported += await writeFeatures(pool, datasetId!, category, payload);
        rows = [];
        await pool.execute("UPDATE geotwin_imports SET records_read=?, records_imported=?, invalid_coordinates=?, duplicate_records=? WHERE id=?", [recordsRead, recordsImported, invalidCoordinates, duplicates, importId]);
      };
      if (geoJson) {
        const items = await readJsonFile(file);
        for (const feature of items) {
          const props = feature.properties ?? {};
          const row = normalizeImportedRow({ ...props, __geoGeometry: feature.geometry }, Object.keys(props), category as Category, true);
          recordsRead++;
          if (!isValidWgs84(row.latitude, row.longitude)) invalidCoordinates++;
          rows.push(row);
          if (rows.length >= 300) await flush();
        }
      } else {
        const parser = createReadStream(file.path).pipe(parseCsv({ bom: true, columns: true, skip_empty_lines: true, relax_column_count: true, trim: true }));
        for await (const raw of parser as AsyncIterable<Record<string, unknown>>) {
          const row = normalizeImportedRow(raw, Object.keys(raw), category as Category);
          recordsRead++;
          if (!isValidWgs84(row.latitude, row.longitude)) invalidCoordinates++;
          rows.push(row);
          if (rows.length >= 300) await flush();
        }
      }
      await flush();
      if (recordsRead === 0) throw new Error("The file contains no data rows.");
      if (invalidCoordinates === recordsRead) throw new Error("No records contain valid WGS84 coordinates. Confirm the source CRS/columns; no records were activated.");
      await pool.execute("UPDATE geotwin_datasets SET status='ready', total_records=?, mapped_records=?, invalid_coordinates=? WHERE id=?", [recordsRead, recordsRead - invalidCoordinates, invalidCoordinates, datasetId]);
      await pool.execute("UPDATE geotwin_imports SET status='succeeded', records_read=?, records_imported=?, invalid_coordinates=?, duplicate_records=?, completed_at=NOW() WHERE id=?", [recordsRead, recordsImported, invalidCoordinates, duplicates, importId]);
      if (req.body.replace === "yes") await pool.execute("UPDATE geotwin_datasets SET active=0 WHERE source_type='upload' AND category=? AND display_name=? AND id<>?", [category, datasetName, datasetId]);
      return res.json({ success: true, datasetId, importId, datasetName, category, recordsRead, recordsImported, invalidCoordinates, duplicateRecords: duplicates, mappedRecords: recordsRead - invalidCoordinates });
    } catch (error) {
      if (datasetId) {
        try { await getDatabase().execute("UPDATE geotwin_datasets SET status='error', active=0 WHERE id=?", [datasetId]); } catch {}
      }
      try { await getDatabase().execute("UPDATE geotwin_imports SET status='failed', details=?, completed_at=NOW() WHERE id=?", [JSON.stringify({ message: error instanceof Error ? error.message : "Import failed" }), importId]); } catch {}
      return res.status(400).json({ error: error instanceof Error ? error.message : "The import failed. Existing datasets were not deleted." });
    } finally { removeFile(file); }
  }));

  app.post("/api/geotwin/analyze", asyncRoute(async (req, res) => {
    const pool = getDatabase();
    const region = typeof req.body?.region === "string" && isAdministrativeRegion(req.body.region) ? req.body.region : null;
    const analysisType = String(req.body?.type ?? "regional").slice(0, 40);
    const [raw] = await pool.query<RowDataPacket[]>("SELECT f.region, f.category, COUNT(*) AS records, SUM(f.latitude IS NOT NULL AND f.longitude IS NOT NULL) AS mapped FROM geotwin_features f INNER JOIN geotwin_datasets d ON f.dataset_id=d.id WHERE d.active=1 AND d.status='ready' AND f.latitude IS NOT NULL AND f.longitude IS NOT NULL AND f.category IN ('Buildings','Roads','Hospitals','Schools','Parks','Water bodies') GROUP BY f.region,f.category");
    const table: Record<string, Record<string, number>> = Object.fromEntries(ANALYTICAL_REGIONS.map(key => [key, Object.fromEntries(CORE_CATEGORIES.map(cat => [cat, 0]))]));
    for (const row of raw) if (table[String(row.region)]) table[String(row.region)][String(row.category)] = Number(row.records);
    const available = CORE_CATEGORIES.filter(cat => raw.some(row => row.category === cat));
    let result: Record<string, unknown>;
    if (analysisType === "quality") {
      const [data] = await pool.query<RowDataPacket[]>("SELECT d.display_name,d.category,d.total_records,d.mapped_records,d.invalid_coordinates,COUNT(f.id) AS stored_records FROM geotwin_datasets d LEFT JOIN geotwin_features f ON f.dataset_id=d.id WHERE d.active=1 AND d.status='ready' GROUP BY d.id ORDER BY d.display_name");
      result = { question: "How complete are the active datasets?", method: "Compare each registry source-row count with mapped/invalid-coordinate counts and persisted feature count. Completeness describes file/coordinate coverage, not positional accuracy or field truth.", datasets: data.map(row => ({ name: row.display_name, category: row.category, sourceRecords: Number(row.total_records), mappedRecords: Number(row.mapped_records), invalidCoordinates: Number(row.invalid_coordinates), storedRecords: Number(row.stored_records), coordinateShare: Number(row.total_records) ? Number(row.mapped_records) / Number(row.total_records) : null })), limitation: "A valid coordinate range cannot certify CRS, geometry correctness or authoritative coverage." };
    } else if (analysisType === "proximity") {
      const regionClause = region ? " AND f.region=?" : "";
      const [facilityRows] = await pool.query<RowDataPacket[]>(`SELECT f.category,f.region,f.latitude,f.longitude FROM geotwin_features f JOIN geotwin_datasets d ON d.id=f.dataset_id WHERE d.active=1 AND d.status='ready' AND f.category IN ('Hospitals','Schools') AND f.latitude IS NOT NULL AND f.longitude IS NOT NULL${regionClause} ORDER BY f.id`, region ? [region] : []);
      const points = facilityRows as { category: string; region: string; latitude: number; longitude: number }[];
      const outputs: Record<string, { category: string; count: number; nearestKmMean: number | null; sample: number; method: string }> = {};
      for (const category of ["Hospitals", "Schools"]) {
        const items = points.filter(p => p.category === category);
        const sample = items.slice(0, 500);
        const nearest = sample.map((point, i) => {
          let best = Infinity;
          for (let j = 0; j < items.length; j++) {
            if (items[j] === point) continue;
            const rad = (d: number) => d * Math.PI / 180;
            const dLat = rad(items[j].latitude - point.latitude), dLon = rad(items[j].longitude - point.longitude);
            const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(point.latitude)) * Math.cos(rad(items[j].latitude)) * Math.sin(dLon / 2) ** 2;
            best = Math.min(best, 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
          }
          return Number.isFinite(best) ? best : null;
        }).filter((v): v is number => v !== null);
        outputs[category] = { category, count: items.length, nearestKmMean: nearest.length ? nearest.reduce((a, b) => a + b, 0) / nearest.length : null, sample: nearest.length, method: "Great-circle Haversine distance to the nearest other mapped feature of the same facility class; first 500 source-ordered records used for calculation." };
      }
      result = { question: "How clustered are mapped education and healthcare facilities?", method: "Within-category nearest-neighbor spacing in a sample of up to 500 mapped source records per category; this is a clustering indicator, not a resident travel-time or service-access model.", facilities: outputs, limitation: "No population, road-network routing, capacity, service boundaries or authoritative completeness denominator is included. Do not infer access or underserved status from this result." };
    } else {
      const selectedRegions = region ? [region] : ANALYTICAL_REGIONS;
      const rows = selectedRegions.map(area => {
        const counts = table[area];
        const total = CORE_CATEGORIES.reduce((sum, category) => sum + (counts[category] ?? 0), 0);
        return { region: area, counts, totalInfrastructureFeatures: total, sourceCategories: available.length };
      });
      result = { question: region ? `What infrastructure records are available in ${region}?` : "How do recorded infrastructure counts compare across the five analytical regions?", method: "Count active, validated feature records with one of the five existing analytical region labels. Regions without source labels are excluded. Counts from incomplete files are not equal to need, population-normalized coverage or investment priority.", regions: rows, availableCategories: available, limitation: "No population denominator or official ward boundary is supplied. Lower counts may reflect dataset coverage, not verified infrastructure gaps." };
    }
    await pool.execute("INSERT INTO geotwin_analyses (analysis_type, region, parameters, result) VALUES (?, ?, ?, ?)", [analysisType, region, jsonString(req.body ?? {}), jsonString(result)]);
    return res.json(result);
  }));

  app.post("/api/geotwin/report", asyncRoute(async (req, res) => {
    const pool = getDatabase();
    const region = typeof req.body?.region === "string" && isAdministrativeRegion(req.body.region) ? req.body.region : null;
    const datasetKeys = Array.isArray(req.body?.datasetKeys) ? [...new Set(req.body.datasetKeys.filter((key: unknown) => typeof key === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(key)))] as string[] : [];
    const allowedIndicators = ["source", "mapped", "coverage"];
    const indicators = Array.isArray(req.body?.indicators) ? [...new Set(req.body.indicators.filter((v: unknown) => allowedIndicators.includes(String(v))))] : allowedIndicators;
    const [rows] = await pool.query<RowDataPacket[]>("SELECT d.dataset_key AS datasetKey, d.display_name AS dataset, d.source_file AS source, f.category, f.region, COUNT(*) AS records, SUM(f.latitude IS NOT NULL AND f.longitude IS NOT NULL) AS mapped FROM geotwin_features f JOIN geotwin_datasets d ON f.dataset_id=d.id WHERE d.active=1 AND d.status='ready' GROUP BY d.id,d.dataset_key,d.display_name,d.source_file,f.category,f.region ORDER BY f.category,f.region,d.display_name");
    const selected = rows.filter(row => (!region || row.region === region || row.region === "Nagpur") && (!datasetKeys.length || datasetKeys.includes(String(row.datasetKey))));
    const summary = { reportDate: new Date().toISOString(), region: region ? `${region} + city-wide records where labelled` : "All analytical regions and city-wide records", indicators, sourceDatasets: [...new Set(selected.map(r => String(r.dataset)))], sourceFiles: [...new Set(selected.map(r => String(r.source)))], records: selected.map(r => { const count = Number(r.records); const mapped = Number(r.mapped); return { datasetKey: String(r.datasetKey), dataset: String(r.dataset), source: String(r.source), category: String(r.category), region: String(r.region ?? "Region not provided"), records: count, mapped, coveragePercent: count ? 100 * mapped / count : null }; }), methodology: "Counts and coordinate coverage are computed from active, persisted feature rows grouped by the selected dataset and source region. City-wide satellite cells remain explicitly labelled and are not reassigned to a named analytical region. Coordinate coverage is mappable-record share, not positional accuracy.", limitations: "The study area is not asserted to be an official administrative boundary. Source completeness, coordinate reference systems and positional accuracy are not independently verified; counts are not population-normalized or investment recommendations." };
    await pool.execute("INSERT INTO geotwin_analyses (analysis_type, region, parameters, result) VALUES ('report', ?, ?, ?)", [region, jsonString({ datasetKeys, indicators }), jsonString(summary)]);
    return res.json(summary);
  }));

  app.get("/api/geotwin/chat/:conversationId", asyncRoute(async (req, res) => {
    const user = signedInUser(res)!;
    const id = accountConversationId(String(req.params.conversationId).slice(0, 100), user);
    const [rows] = await getDatabase().execute<RowDataPacket[]>("SELECT role, content, context, created_at AS createdAt FROM geotwin_chat_messages WHERE conversation_id=? ORDER BY id DESC LIMIT 40", [id]);
    return res.json({ messages: rows.reverse().map(row => ({ role: row.role, content: row.content, context: parseJson(row.context, null), createdAt: row.createdAt })) });
  }));

  app.post("/api/geotwin/chat", asyncRoute(async (req, res) => {
    const pool = getDatabase();
    const question = String(req.body?.question ?? "").trim().slice(0, 1500);
    const rawConversationId = String(req.body?.conversationId ?? "").replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 100);
    const user = signedInUser(res)!;
    const conversationId = rawConversationId ? accountConversationId(rawConversationId, user) : "";
    if (!question) return res.status(400).json({ error: "Ask a city-planning question." });
    if (!conversationId) return res.status(400).json({ error: "Conversation identifier is required." });
    const [datasetRows] = await pool.query<RowDataPacket[]>("SELECT category, SUM(total_records) AS records, SUM(mapped_records) AS mapped FROM geotwin_datasets WHERE active=1 AND status='ready' GROUP BY category");
    const [regionRows] = await pool.query<RowDataPacket[]>("SELECT f.region,f.category,COUNT(*) AS records FROM geotwin_features f JOIN geotwin_datasets d ON f.dataset_id=d.id WHERE d.active=1 AND d.status='ready' AND f.category IN ('Buildings','Roads','Hospitals','Schools','Parks','Water bodies') AND f.region IN ('North','South','East','West','Central') GROUP BY f.region,f.category");
    const stats = Object.fromEntries(datasetRows.map(row => [String(row.category), { records: Number(row.records), mapped: Number(row.mapped) }]));
    const regions = Object.fromEntries(ANALYTICAL_REGIONS.map(r => [r, Object.fromEntries(CORE_CATEGORIES.map(cat => [cat, 0]))]));
    for (const row of regionRows) if (regions[String(row.region)]) regions[String(row.region)][String(row.category)] = Number(row.records);
    let action: null | { type: string; category?: string; section?: string } = null;
    const asksForMap = /\b(show|display|map|locate|find|open|put)\b/i.test(question);
    const requestedLayer: [Category, RegExp][] = [["Hospitals", /\bhospitals?\b/i], ["Schools", /\bschools?\b/i], ["Roads", /\broads?\b/i], ["Parks", /\bparks?\b|\bgreen\s*space/i], ["Water bodies", /\bwater\s*bodies\b|\bwater\b|\blakes?\b/i], ["Buildings", /\bbuildings?\b|\bfootprints?\b/i], ["Flood risk", /\bflood\s*risk\b|\brisk\s*layer/i], ["Built-up", /\bbuilt[- ]?up\b/i], ["Green cover", /\bgreen\b/i], ["NDVI", /\bndvi\b|\bvegetation\b/i]];
    const layerChoice = requestedLayer.find(([, expression]) => expression.test(question));
    const comparisonIntent = /\bcompare|\bacross\b|\bfive regions\b|\ball regions\b/i.test(question);
    if (asksForMap && layerChoice) action = { type: "layer", category: layerChoice[0] };
    else if (/\bquality|missing|invalid|coordinate|data quality\b/i.test(question)) action = { type: "section", section: "Data Management" };
    else if (/\bpriority|development-priority|infrastructure assessment|underserved\b/i.test(question)) action = { type: "section", section: "Intelligence" };
    else if (/\bcompare|analysis|analy[sz]e\b/i.test(question)) action = { type: "section", section: "Analyze" };
    const catMatch = ALL_CATEGORIES.find(cat => question.toLowerCase().includes(cat.toLowerCase().replace("water bodies", "water"))) ?? (layerChoice?.[0] ?? null);
    const coreCatMatch = catMatch ? CORE_CATEGORIES.find(category => category === catMatch) ?? null : null;
    const regionMatch = ANALYTICAL_REGIONS.find(region => question.toLowerCase().includes(region.toLowerCase()));
    const requestedRegion = typeof req.body?.region === "string" && isAdministrativeRegion(req.body.region) ? req.body.region : null;
    const answerRegion = regionMatch ?? (comparisonIntent ? null : requestedRegion);
    let localAnswer = "I can answer from the imported source records, explain current data quality, compare the five project regions, or open a map layer. I cannot verify official planning needs from feature counts alone.";
    if (/quality|missing|invalid|coordinate/i.test(question)) {
      const mapped = Object.values(stats).reduce((sum, row) => sum + row.mapped, 0);
      const total = Object.values(stats).reduce((sum, row) => sum + row.records, 0);
      localAnswer = `The active registry contains ${Object.keys(stats).length} categories with ${total.toLocaleString()} source records; ${mapped.toLocaleString()} are marked as mappable. Coordinate-range validation does not verify CRS or positional accuracy. See Data Management for per-file counts and source details.`;
    } else if (comparisonIntent && catMatch) {
      const comparison = ANALYTICAL_REGIONS.map(region => ({ region, records: regions[region]?.[catMatch] ?? 0 })).sort((a, b) => b.records - a.records);
      localAnswer = `Recorded ${catMatch.toLowerCase()} by project region: ${comparison.map(row => `${row.region} ${row.records.toLocaleString()}`).join(" · ")}. This is a comparison of the currently active, source-labeled database records only; it is not normalized for population or service capacity, and the regions are not official wards.`;
    } else if (answerRegion && coreCatMatch) {
      const count = regions[answerRegion]?.[coreCatMatch] ?? 0;
      localAnswer = `${answerRegion} has ${count.toLocaleString()} mapped ${coreCatMatch.toLowerCase()} feature records among the available records with that analytical region label. This is a source-data count, not a population-normalized coverage measure or a verified planning gap.`;
    } else if (/\b(assessment|priority|underserved|coverage gap)\b/i.test(question)) {
      const categories = ["Hospitals", "Schools", "Parks", "Water bodies"];
      const priorities = ANALYTICAL_REGIONS.map(region => {
        const row = regions[region] ?? {};
        const score = Math.round(100 * categories.reduce((sum, category) => sum + (1 - Number(row[category] ?? 0) / Math.max(...ANALYTICAL_REGIONS.map(area => Number(regions[area]?.[category] ?? 0)), 1)), 0) / categories.length);
        return { region, score };
      }).sort((a, b) => b.score - a.score);
      localAnswer = `The configurable baseline ranks ${priorities.map(row => `${row.region} ${row.score}/100`).join(" · ")} for review of relative hospital, school, park and water-body counts. Higher scores mean fewer recorded features relative to category maxima, not a need or confirmed service gap. Check source completeness, population, capacity and travel access before making a planning decision.`;
    } else if (answerRegion && /infrastructure|more|less|total|facilit/i.test(question)) {
      const counts = regions[answerRegion] ?? {};
      const breakdown = CORE_CATEGORIES.map(category => `${category}: ${(counts[category] ?? 0).toLocaleString()}`).join(" · ");
      const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
      localAnswer = `${answerRegion} has ${total.toLocaleString()} active, source-labeled core infrastructure features in the current records (${breakdown}). This is an inventory summary, not a population-normalized coverage result. Source completeness, capacity and official administrative boundaries are not verified.`;
    } else if (catMatch) {
      const regionalMatch = Boolean(answerRegion && coreCatMatch);
      const count = regionalMatch ? (regions[answerRegion!]?.[coreCatMatch!] ?? 0) : (stats[catMatch]?.records ?? 0);
      const scope = regionalMatch ? ` in ${answerRegion}` : " in the active source registry";
      localAnswer = `${catMatch} has ${count.toLocaleString()} active database records${scope}${regionalMatch ? " with that analytical region label" : ` (${(stats[catMatch]?.mapped ?? 0).toLocaleString()} marked mappable)`}. This count may be used to inspect the map; source verification is still required for operational planning.`;
    }
    await pool.execute("INSERT INTO geotwin_chat_messages (conversation_id, role, content, context) VALUES (?, 'user', ?, ?)", [conversationId, question, jsonString({ region: req.body?.region ?? null })]);
    const contextData = { selectedRegion: answerRegion, availableRecordCounts: stats, regionalFeatureCounts: regions, caveats: ["Regions are analytical, not official wards", "No population denominator", "Do not infer need from incomplete feature counts", "Values come from active database records"] };
    let answer = localAnswer;
    let aiUsed = false;
    if (ENV.forgeApiUrl.trim() && ENV.forgeApiKey.trim()) {
      try {
        const response = await invokeLLM({ messages: [
            { role: "system", content: "You are GeoTwinAI Planning Assistant. Interpret only the verified database aggregates supplied in the user message. Never invent counts, execute SQL, claim realtime/official coverage or call count differences confirmed underserved areas. Distinguish counts and recommendations; mention missing population/quality caveats briefly. If data are absent say so. Answer clearly and compactly." },
            { role: "user", content: `Question: ${question}\n\nVerified database results (JSON): ${JSON.stringify(contextData)}\n\nDeterministic evidence-based answer if helpful: ${localAnswer}` },
          ], maxTokens: 280 });
        const resultContent = response.choices?.[0]?.message?.content;
        const content = typeof resultContent === "string" ? resultContent.trim() : Array.isArray(resultContent) ? resultContent.map(part => part.type === "text" ? part.text : "").join("\n").trim() : "";
        if (content) { answer = content; aiUsed = true; }
        else console.warn("[GeoTwinAI] Managed AI returned no usable completion; local database mode remains active.");
      } catch (error) { console.warn("[GeoTwinAI] AI unavailable; deterministic data mode remains active", error); }
    }
    await pool.execute("INSERT INTO geotwin_chat_messages (conversation_id, role, content, context) VALUES (?, 'assistant', ?, ?)", [conversationId, answer, jsonString({ action, aiUsed, evidence: contextData })]);
    return res.json({ answer, action, aiUsed, mode: aiUsed ? "managed-ai-grounded-in-database" : "database-query-mode", evidence: localAnswer });
  }));

  app.use("/api/geotwin", (error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    if (error instanceof multer.MulterError) return res.status(413).json({ error: "Upload exceeds the 50 MB per-file limit or request limits." });
    return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid request." });
  });
}
