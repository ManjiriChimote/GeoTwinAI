export type Page = "Overview" | "Explore" | "Analyze" | "Intelligence" | "Report" | "Data Management" | "Settings";
export type Region = "North" | "South" | "East" | "West" | "Central" | "All regions";
export type Category = "Buildings" | "Roads" | "Hospitals" | "Schools" | "Parks" | "Water bodies" | "Built-up" | "Green cover" | "Flood risk" | "NDVI";
export type Dataset = {
  id: number; key: string; name: string; category: Category; source: string; sourceType: "seed" | "upload";
  status: "ready" | "processing" | "error"; active: boolean; records: number; mappedRecords: number;
  invalidCoordinates: number; metadata: Record<string, unknown>; importedAt?: string;
};
export type GeoFeature = {
  id: number; category: Category; region: string | null; name: string | null; latitude: number; longitude: number;
  geometryType: string | null; geometry: string | null; properties: Record<string, unknown>; dataset: string; sourceFile: string;
};
export type Summary = {
  center: { latitude: number; longitude: number }; regions: string[]; coreCategories: Category[]; categories: Category[];
  datasets: Dataset[]; counts: Record<string, { records: number; mapped: number }>;
  regionalCounts: Record<string, Record<string, number>>; metrics: { key: string; source: string; value: Record<string, unknown> }[];
  quality: { total: number; mapped: number; datasets: number }; provenance: string;
};
export type ImportItem = {
  id: number; datasetId?: number | null; source: string; category: Category; status: string;
  recordsRead: number; recordsImported: number; invalidCoordinates: number; duplicateRecords: number;
  details: Record<string, unknown>; startedAt: string; completedAt?: string | null;
};
export type ReportIndicator = "source" | "mapped" | "coverage";
export type ReportRecord = { datasetKey: string; dataset: string; source: string; category: Category; region: string; records: number; mapped: number; coveragePercent: number | null };
export type GeoTwinReport = { reportDate: string; region: string; indicators: ReportIndicator[]; sourceDatasets: string[]; sourceFiles: string[]; records: ReportRecord[]; methodology: string; limitations: string };
export type DatasetResponse = { datasets: Dataset[]; imports: ImportItem[] };
export type GeoAction = { type: "layer"; category: Category } | { type: "section"; section: Page } | null;

export type GeoTwinAccount = { id: number; accountId: number; openId: string; name: string; email: string; role: "user" | "admin" };
export const GEO_TWIN_AUTH_EXPIRED_EVENT = "geotwin-auth-expired";
export const GEO_TWIN_CSRF_HEADER = "x-geotwin-csrf-token";
let csrfToken = "";
export const setGeoTwinCsrfToken = (token: string) => { csrfToken = token; };
export function geoTwinCsrfHeaders(method: string): Record<string, string> {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) && csrfToken ? { [GEO_TWIN_CSRF_HEADER]: csrfToken } : {};
}

export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const method = (init?.method ?? "GET").toUpperCase();
  for (const [name, value] of Object.entries(geoTwinCsrfHeaders(method))) headers.set(name, value);
  const response = await fetch(url, { ...init, headers, credentials: init?.credentials ?? "same-origin" });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && !url.includes("/api/geotwin/auth/") && typeof window !== "undefined") window.dispatchEvent(new Event(GEO_TWIN_AUTH_EXPIRED_EVENT));
  if (!response.ok) throw new Error(body?.error || body?.message || `Request failed (${response.status})`);
  return body as T;
}

export const formatNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(number) : "—";
};
export const formatDate = (value?: string | null) => value ? new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value)) : "—";
