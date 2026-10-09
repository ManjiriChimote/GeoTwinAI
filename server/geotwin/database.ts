import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import path from "node:path";
import { fileURLToPath } from "node:url";

type FeatureSeed = {
  category: string;
  dataset: string;
  slug: string;
  region: string;
  latitude: number | null;
  longitude: number | null;
  geometryType: string;
  geometry: string;
  properties: Record<string, string>;
};
type SeedManifest = {
  datasets: { file: string; category: string; rows: number; mappedRows: number; invalidCoordinates: number; sha256: string }[];
};
const seedDir = path.resolve(process.cwd(), "server/data/seed");
let pool: Pool | null = null;

export function getPool(): Pool | null {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) pool = mysql.createPool(process.env.DATABASE_URL);
  return pool;
}

export async function closePool() {
  if (pool) await pool.end();
  pool = null;
}

export async function databaseReady() {
  const p = getPool();
  if (!p) return false;
  try {
    await p.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

function featureName(f: FeatureSeed) {
  const p = f.properties;
  const result = p.name || p["name:en"] || p["name:mr"] || p.building || p.highway || p.Green_Cover_Class || p.Flood_Risk_Class || p.NDVI_Class || p.BuiltUp_Class;
  return result ? String(result).slice(0, 255) : null;
}

function digest(f: FeatureSeed) {
  return createHash("sha256").update(`${f.slug}\u0000${f.region}\u0000${f.geometry || `${f.latitude},${f.longitude}`}\u0000${JSON.stringify(f.properties)}`).digest("hex");
}

/**
 * Ingests the clean source archive once into the managed project database. A lock prevents
 * multiple app workers from racing; completed seed datasets are never reset on restart.
 */
export async function seedProjectData() {
  const p = getPool();
  if (!p) return { ok: false, reason: "DATABASE_URL is not configured" };
  const [[lock] = []] = await p.query<RowDataPacket[]>("SELECT GET_LOCK('geotwinai-bootstrap-v1', 15) AS acquired");
  if (Number(lock?.acquired) !== 1) return { ok: false, reason: "Another GeoTwinAI data initializer is active" };
  try {
    const manifest: SeedManifest = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(seedDir, "provenance.json"), "utf8"));
    const summaryText = await (await import("node:fs/promises")).readFile(path.join(seedDir, "nagpur-summaries.json"), "utf8");
    const summaries = JSON.parse(summaryText) as { source: string; records: Record<string, string>[] }[];
    for (const entry of summaries) {
      for (const [index, item] of entry.records.entries()) {
        const metricKey = `${entry.source}:${index}`;
        await p.execute(
          "INSERT INTO geotwin_metrics (metric_key, source_file, payload) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE payload = IF(payload = VALUES(payload), payload, payload)",
          [metricKey, entry.source, JSON.stringify(item)],
        );
      }
    }
    const seeds = new Map(manifest.datasets.map(item => [item.file.replace(/_Clean\.csv$/, "").replace(/_Spatial$/, ""), item]));
    const existing = new Map<string, { id: number; status: string }>();
    const [rows] = await p.query<RowDataPacket[]>("SELECT id, dataset_key, status FROM geotwin_datasets WHERE dataset_key LIKE 'seed-%'");
    for (const row of rows) existing.set(String(row.dataset_key).replace(/^seed-/, ""), { id: Number(row.id), status: String(row.status) });

    const input = createReadStream(path.join(seedDir, "nagpur-features.jsonl.gz")).pipe(createGunzip());
    const lines = createInterface({ input, crlfDelay: Infinity });
    let currentSlug = "";
    let currentId = 0;
    let currentCategory = "";
    let currentSource = "";
    let sourceRows = 0;
    let importedRows = 0;
    let mappedRows = 0;
    let batch: unknown[][] = [];
    const flush = async () => {
      if (!batch.length) return;
      const tuples = batch.map(() => "(?,?,?,?,?,?,?,?,?,?,NOW())").join(",");
      const values = batch.flat();
      const [result] = await p.execute(`INSERT IGNORE INTO geotwin_features (dataset_id, category, region, feature_hash, name, latitude, longitude, geometry_type, geometry, properties, created_at) VALUES ${tuples}`, values as never[]);
      importedRows += Number((result as { affectedRows?: number }).affectedRows || 0);
      batch = [];
    };
    let prior = "";
    for await (const line of lines) {
      if (!line) continue;
      const feature = JSON.parse(line) as FeatureSeed;
      if (feature.slug !== currentSlug) {
        await flush();
        if (currentSlug && currentId !== -1) {
          const data = seeds.get(currentSource);
          await p.execute("UPDATE geotwin_datasets SET status='ready', total_records=?, mapped_records=?, invalid_coordinates=?, imported_at=NOW() WHERE id=?", [sourceRows, mappedRows, Math.max(0, (data?.rows ?? sourceRows) - (data?.mappedRows ?? mappedRows)), currentId]);
          await p.execute("UPDATE geotwin_imports SET status='succeeded', records_read=?, records_imported=?, completed_at=NOW() WHERE id=?", [sourceRows, importedRows, prior]);
        }
        currentSlug = feature.slug;
        currentCategory = feature.category;
        currentSource = feature.dataset;
        sourceRows = importedRows = mappedRows = 0;
        const previous = existing.get(currentSlug);
        if (previous?.status === "ready") {
          // The input gzip is ordered by slug. Skip this completed dataset without rewriting user data.
          currentId = -1;
          continue;
        }
        const meta = seeds.get(currentSource);
        const displayName = currentSource.replace(/^Nagpur_/, "").replace(/_/g, " ");
        if (previous) {
          currentId = previous.id;
          await p.execute("DELETE FROM geotwin_features WHERE dataset_id=?", [currentId]);
          await p.execute("UPDATE geotwin_datasets SET status='processing', total_records=0, mapped_records=0 WHERE id=?", [currentId]);
        } else {
          const [insert] = await p.execute("INSERT INTO geotwin_datasets (dataset_key, display_name, category, source_file, source_type, status, active, total_records, mapped_records, invalid_coordinates, metadata, source_hash) VALUES (?, ?, ?, ?, 'seed', 'processing', 1, 0, 0, 0, ?, ?)", [`seed-${currentSlug}`, displayName, currentCategory, meta?.file ?? currentSource, JSON.stringify({ provenance: "Supplied project archive; clean non-duplicate CSV", scope: "Nagpur study area", sourceRecordCount: meta?.rows ?? 0, mappableRecords: meta?.mappedRows ?? 0 }), meta?.sha256 ?? null]);
          currentId = Number((insert as { insertId?: number }).insertId);
        }
        const [hist] = await p.execute("INSERT INTO geotwin_imports (dataset_id, source_file, category, status, records_read, records_imported, invalid_coordinates, details) VALUES (?, ?, ?, 'processing', 0, 0, 0, ?)", [currentId, meta?.file ?? currentSource, currentCategory, JSON.stringify({ source: "bundled bootstrap", idempotent: true })]);
        prior = String((hist as { insertId?: number }).insertId);
      }
      if (currentId === -1) continue;
      sourceRows++;
      if (feature.latitude !== null && feature.longitude !== null) mappedRows++;
      batch.push([currentId, feature.category, feature.region || null, digest(feature), featureName(feature), feature.latitude, feature.longitude, feature.geometryType || null, feature.geometry || null, JSON.stringify(feature.properties || {})]);
      if (batch.length >= 250) await flush();
    }
    await flush();
    if (currentSlug && currentId !== -1) {
      const data = seeds.get(currentSource);
      await p.execute("UPDATE geotwin_datasets SET status='ready', total_records=?, mapped_records=?, invalid_coordinates=?, imported_at=NOW() WHERE id=?", [sourceRows, mappedRows, Math.max(0, (data?.rows ?? sourceRows) - (data?.mappedRows ?? mappedRows)), currentId]);
      await p.execute("UPDATE geotwin_imports SET status='succeeded', records_read=?, records_imported=?, completed_at=NOW() WHERE id=?", [sourceRows, importedRows, prior]);
    }
    return { ok: true, sourceRows: manifest.datasets.reduce((sum, d) => sum + d.rows, 0) };
  } finally {
    await p.query("SELECT RELEASE_LOCK('geotwinai-bootstrap-v1')");
  }
}

export function parseJson(value: unknown, fallback: unknown = {}) {
  try { return typeof value === "string" ? JSON.parse(value) : value ?? fallback; } catch { return fallback; }
}
