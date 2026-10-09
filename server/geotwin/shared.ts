export const ANALYTICAL_REGIONS = ["North", "South", "East", "West", "Central"] as const;
export const CORE_CATEGORIES = ["Buildings", "Roads", "Hospitals", "Schools", "Parks", "Water bodies"] as const;
export const ALL_CATEGORIES = [...CORE_CATEGORIES, "Built-up", "Green cover", "Flood risk", "NDVI"] as const;
export type Category = (typeof ALL_CATEGORIES)[number];

export function normalizeKey(key: string) {
  return key.trim().toLowerCase().replace(/[\s\-.:/]+/g, "_").replace(/[^a-z0-9_]/g, "").replace(/_+/g, "_");
}

const aliases = {
  lat: ["latitude", "lat", "y", "coord_y", "northing"],
  lon: ["longitude", "lon", "lng", "x", "coord_x", "easting"],
  region: ["region", "zone", "area", "geo_region", "geotwin_region"],
  geometry: ["geometry", "geom", "wkt", "the_geom", "shape"],
  name: ["name", "name_en", "name_mr", "display_name", "amenity", "building", "highway", "type"],
} as const;

export function findColumn(headers: string[], field: keyof typeof aliases) {
  const normalized = headers.map(normalizeKey);
  for (const alias of aliases[field]) {
    const idx = normalized.indexOf(alias);
    if (idx >= 0) return headers[idx];
  }
  return undefined;
}

export function numberOrNull(value: unknown) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function identifyCategory(value: string, filename = ""): Category {
  const raw = `${value} ${filename}`.toLowerCase();
  if (/hospital|health|medical/.test(raw)) return "Hospitals";
  if (/school|education/.test(raw)) return "Schools";
  if (/park|green|vegetation|ndvi/.test(raw)) return /ndvi|vegetation|satellite/.test(raw) && !/park/.test(raw) ? (raw.includes("ndvi") ? "NDVI" : "Green cover") : "Parks";
  if (/water|lake|pond/.test(raw)) return "Water bodies";
  if (/road|street|highway|traffic/.test(raw)) return "Roads";
  if (/building|built.?up/.test(raw)) return "Buildings";
  if (/flood|risk/.test(raw)) return "Flood risk";
  return "Buildings";
}

export function isValidWgs84(latitude: number | null, longitude: number | null) {
  return latitude !== null && longitude !== null && Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

export function parseWktPoint(wkt: string) {
  const match = wkt.trim().match(/^POINT\s*\(\s*([-+\d.eE]+)\s+([-+\d.eE]+)\s*\)$/i);
  return match ? { longitude: Number(match[1]), latitude: Number(match[2]) } : null;
}

export function safeName(props: Record<string, unknown>, fallback = "Unnamed feature") {
  const candidates = ["name", "name:en", "name_en", "name:mr", "building", "highway", "amenity", "type", "Green_Cover_Class", "Flood_Risk_Class", "NDVI_Class"];
  for (const key of candidates) {
    const value = props[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim().slice(0, 255);
  }
  return fallback;
}
