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

export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (!headers.has("Authorization") && typeof window !== "undefined") {
    try {
      const previewToken = sessionStorage.getItem("manus-cookie");
      if (previewToken) headers.set("Authorization", `Bearer ${previewToken}`);
    } catch {}
  }
  const response = await fetch(url, { ...init, headers, credentials: init?.credentials ?? "same-origin" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || body?.message || `Request failed (${response.status})`);
  return body as T;
}

export const formatNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(number) : "—";
};
export const formatDate = (value?: string | null) => value ? new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value)) : "—";
