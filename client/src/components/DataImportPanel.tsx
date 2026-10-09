import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowDownToLine, Check, CheckCircle2, Database, FileUp, Layers3, LoaderCircle, MapPin, RefreshCw, Search, Trash2, UploadCloud } from "lucide-react";
import { apiJson, formatDate, formatNumber, type Category, type DatasetResponse, type ImportItem, type Region } from "@/lib/geotwin-api";

type Preview = { previewId: number; fileName: string; bytes: number; format: string; category: Category; headers: string[]; preview: Record<string, unknown>[]; sampleCount: number; spatiallyLocatedSample: number; geometryDetected: string; coordinateColumns: { latitude?: string; longitude?: string }; crs: string; needsCrsConfirmation: boolean; limitations: string };
type Props = { region: Region; canManage: boolean; onDataChanged: () => void };
const categories: Category[] = ["Buildings", "Roads", "Hospitals", "Schools", "Parks", "Water bodies", "Built-up", "Green cover", "Flood risk", "NDVI"];

function xhrImport(file: File, preview: Preview, name: string, crsConfirmed: boolean, replace: boolean, onProgress: (value: number) => void) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const form = new FormData(); form.append("file", file); form.append("previewId", String(preview.previewId)); form.append("confirm", "yes"); form.append("category", preview.category); form.append("datasetName", name); form.append("crsConfirmed", crsConfirmed ? "yes" : "no"); form.append("replace", replace ? "yes" : "no");
    const request = new XMLHttpRequest(); request.open("POST", "/api/geotwin/import"); request.withCredentials = true;
    try { const previewToken = sessionStorage.getItem("manus-cookie"); if (previewToken) request.setRequestHeader("Authorization", `Bearer ${previewToken}`); } catch {}
    request.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    request.onload = () => {
      const body = (() => { try { return JSON.parse(request.responseText); } catch { return {}; } })();
      if (request.status >= 200 && request.status < 300) resolve(body); else reject(new Error(body.error || `Import failed (${request.status})`));
    };
    request.onerror = () => reject(new Error("Upload interrupted. Your existing datasets remain intact."));
    request.send(form);
  });
}

export default function DataImportPanel({ region, canManage, onDataChanged }: Props) {
  const [payload, setPayload] = useState<DatasetResponse>({ datasets: [], imports: [] });
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState<Category>("Buildings");
  const [datasetName, setDatasetName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmCrs, setConfirmCrs] = useState(false);
  const [replace, setReplace] = useState(false);
  const [progress, setProgress] = useState(0);
  const [inFlightId, setInFlightId] = useState<number | null>(null);

  const refresh = async () => {
    try { setPayload(await apiJson<DatasetResponse>("/api/geotwin/datasets")); } catch (e) { setError(e instanceof Error ? e.message : "Datasets are temporarily unavailable."); }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!inFlightId) return;
    const timer = window.setInterval(async () => {
      try { const status = await apiJson<ImportItem>(`/api/geotwin/imports/${inFlightId}`); if (status.status === "succeeded" || status.status === "failed") { setInFlightId(null); await refresh(); onDataChanged(); } }
      catch { /* final upload response carries the actual outcome */ }
    }, 1300);
    return () => window.clearInterval(timer);
  }, [inFlightId]);

  const availableActive = useMemo(() => payload.datasets.filter(d => d.status === "ready" && d.active), [payload.datasets]);

  const previewSource = async () => {
    if (!file) { setError("Choose a CSV or GeoJSON source file."); return; }
    setLoading(true); setError(""); setNotice(""); setPreview(null);
    const form = new FormData(); form.append("file", file); form.append("category", category);
    try {
      const result = await apiJson<Preview>("/api/geotwin/upload-preview", { method: "POST", body: form });
      setPreview(result); setDatasetName(name => name || file.name.replace(/\.(csv|geojson|json)$/i, "").replace(/[_-]+/g, " ")); setConfirmCrs(result.format === "GeoJSON");
    } catch (e) { setError(e instanceof Error ? e.message : "The file could not be previewed."); }
    finally { setLoading(false); }
  };

  const confirmImport = async () => {
    if (!file || !preview) return;
    if (preview.needsCrsConfirmation && !confirmCrs) { setError("Confirm that the supplied coordinate columns are geographic WGS84 latitude/longitude before importing."); return; }
    const duplicate = availableActive.find(d => d.category === preview.category && d.name.toLowerCase() === datasetName.trim().toLowerCase());
    if (duplicate && !replace) { setError("A dataset with this name and category is already active. Choose a different name or enable versioned replacement."); return; }
    setLoading(true); setError(""); setProgress(0); setNotice("Transfer begins at 0%; the server then validates and persists records in batches."); setInFlightId(preview.previewId);
    try {
      const result = await xhrImport(file, { ...preview, category }, datasetName, confirmCrs, replace, setProgress);
      setNotice(`Imported ${formatNumber(result.recordsImported)} records; ${formatNumber(result.invalidCoordinates)} had invalid or missing coordinates and ${formatNumber(result.duplicateRecords)} duplicates were skipped.`);
      setPreview(null); setFile(null); setDatasetName(""); setReplace(false); setConfirmCrs(false); await refresh(); onDataChanged();
    } catch (e) { setError(e instanceof Error ? e.message : "The import could not be completed."); setInFlightId(null); await refresh(); }
    finally { setLoading(false); }
  };

  const toggleDataset = async (id: number, active: boolean) => {
    setError("");
    try { await apiJson(`/api/geotwin/datasets/${id}`, { method: "PATCH", body: JSON.stringify({ active }) }); await refresh(); onDataChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : "Dataset status could not be saved."); }
  };
  const deleteDataset = async (id: number, name: string) => {
    if (!window.confirm(`Delete the uploaded dataset “${name}” and its feature rows? This cannot be undone.`)) return;
    try { await apiJson(`/api/geotwin/datasets/${id}?confirm=delete`, { method: "DELETE" }); setNotice("Uploaded dataset deleted."); await refresh(); onDataChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : "Dataset could not be deleted."); }
  };
  const downloadManifest = () => {
    const rows = [["Dataset", "Category", "Origin", "Status", "Active", "Source records", "Mapped records", "Missing/invalid coordinates", "Imported"], ...payload.datasets.map(d => [d.name, d.category, d.sourceType, d.status, String(d.active), String(d.records), String(d.mappedRecords), String(d.invalidCoordinates), d.importedAt ?? ""])];
    const safeCell = (value: string) => { const text = String(value ?? "").replace(/\u0000/g, ""); const safe = /^[ \t\r]*[=+\-@]/.test(text) ? `'${text}` : text; return `"${safe.replace(/"/g, '""')}"`; };
    const csv = rows.map(row => row.map(safeCell).join(",")).join("\r\n");
    const a = document.createElement("a"); const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" })); a.href = url; a.download = "geotwinai-dataset-registry.csv"; a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 3000);
  };

  return <div className="data-management-layout">
    <div className="section-lead-row"><div><span className="eyebrow">WORKSPACE DATA</span><h2>{canManage?"Manage your source records":"Inspect source records"}</h2><p>Browse preloaded Nagpur records or review the import registry. The project owner alone can add, activate or remove datasets.</p></div><button className="secondary-btn" onClick={downloadManifest} disabled={!payload.datasets.length}><ArrowDownToLine size={16} />Export registry</button></div>
    {!canManage&&<div className="read-only-callout" role="status">Read-only workspace access. Dataset import, activation and deletion are restricted to the configured project owner.</div>}
    {(error || notice) && <div className={`notice-bar ${error ? "notice-error" : "notice-success"}`}><span>{error ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}{error || notice}</span><button onClick={() => { setError(""); setNotice(""); }} aria-label="Dismiss message">×</button></div>}
    <div className="data-quick-stats"><div><Database size={17} /><span>Active datasets</span><strong>{formatNumber(availableActive.length)}</strong></div><div><Layers3 size={17} /><span>Source records</span><strong>{formatNumber(availableActive.reduce((sum,d)=>sum+d.records,0))}</strong></div><div><MapPin size={17} /><span>Mapped records</span><strong>{formatNumber(availableActive.reduce((sum,d)=>sum+d.mappedRecords,0))}</strong></div><div><RefreshCw size={17} /><span>Study region</span><strong>{region}</strong></div></div>
    <div className="data-ingest-card">
      <div className="card-heading"><div><span className="eyebrow">ADD A SOURCE</span><h3>Bring in a dataset</h3><p>Preview the schema before anything is written. CSV and GeoJSON are supported; file limit 50 MB.</p></div><UploadCloud size={20} className="heading-mark" /></div>
      <div className="ingest-form">
        <label className={`dropzone ${file ? "has-file" : ""} ${!canManage?"dropzone-readonly":""}`} htmlFor="dataset-file"><input id="dataset-file" type="file" accept=".csv,.geojson,.json,text/csv,application/geo+json,application/json" disabled={!canManage} onChange={e => { const next = e.target.files?.[0] ?? null; setFile(next); setPreview(null); setError(""); setDatasetName(""); }} /><span className="upload-glyph">{file ? <Check size={20} /> : <FileUp size={20} />}</span><strong>{file ? file.name : canManage?"Choose a source file":"Owner permission required to upload"}</strong><span>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB · source stays unchanged` : "CSV or GeoJSON · up to 50 MB"}</span><small>Map features and original attributes are kept in the database.</small></label>
        <div className="ingest-fields"><label>Dataset label<input value={datasetName} onChange={e => setDatasetName(e.target.value)} maxLength={255} placeholder="e.g. Central hospitals · 2026" disabled={!canManage} /></label><label>Record category<select value={category} onChange={e => setCategory(e.target.value as Category)} disabled={!canManage}>{categories.map(c => <option key={c}>{c}</option>)}</select></label><button className="primary-btn" onClick={previewSource} disabled={!canManage || !file || loading}>{loading && !preview ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />} Preview schema</button></div>
      </div>
      {preview && <div className="preview-panel">
        <div className="preview-title"><div><span className="eyebrow">READY FOR REVIEW · {preview.format.toUpperCase()}</span><strong>{preview.fileName}</strong></div><span className="preview-tag">{(preview.bytes / 1024 / 1024).toFixed(2)} MB</span></div>
        <div className="preview-summary-grid"><div><span>Sample fields</span><strong>{formatNumber(preview.headers.length)}</strong></div><div><span>Sample rows</span><strong>{formatNumber(preview.sampleCount)}</strong></div><div><span>Sample with locations</span><strong>{formatNumber(preview.spatiallyLocatedSample)} / {formatNumber(preview.sampleCount)}</strong></div><div><span>Geometry</span><strong>{preview.geometryDetected}</strong></div></div>
        <p className="crs-note"><MapPin size={15} />{preview.crs}</p>
        {preview.headers.length > 0 && <div className="schema-chips">{preview.headers.slice(0,24).map(h => <code key={h}>{h}</code>)}{preview.headers.length > 24 && <span>+{preview.headers.length - 24} more fields</span>}</div>}
        {preview.preview.length > 0 && <div className="sample-table-wrap"><table className="sample-table"><thead><tr>{preview.headers.slice(0,6).map(k => <th key={k}>{k}</th>)}</tr></thead><tbody>{preview.preview.slice(0,4).map((row,i)=><tr key={i}>{preview.headers.slice(0,6).map(k=><td key={k}>{String(row[k] ?? "—").slice(0,52)}</td>)}</tr>)}</tbody></table></div>}
        <div className="import-confirm-row"><div className="confirmation-options">
          {preview.needsCrsConfirmation && <label className="confirm-check"><input type="checkbox" checked={confirmCrs} disabled={!canManage} onChange={e => setConfirmCrs(e.target.checked)} /><span>I confirm the coordinate columns use WGS84 latitude / longitude, not a projected CRS.</span></label>}
          {availableActive.some(d => d.category === category && d.name.toLowerCase() === datasetName.trim().toLowerCase()) && <label className="confirm-check"><input type="checkbox" checked={replace} disabled={!canManage} onChange={e => setReplace(e.target.checked)} /><span>Version this dataset and deactivate the existing same-name dataset. Previous records remain stored.</span></label>}
          <small>{preview.limitations} · GeoPackage is not accepted directly in this version. Export it to GeoJSON first.</small>
        </div><button className="primary-btn" onClick={confirmImport} disabled={!canManage || loading || !datasetName.trim() || (preview.needsCrsConfirmation && !confirmCrs)}>{loading ? <><LoaderCircle className="spin" size={15} />Importing</> : <><UploadCloud size={15} />Confirm import</>}</button></div>
        {(loading || inFlightId !== null) && <div className="upload-progress"><div className="progress-track"><span style={{ width: `${progress}%` }} /></div><div><span>{progress < 100 ? `Uploading file · ${progress}%` : "Upload complete · validating database batches…"}</span><span>{progress === 100 ? "Validation / insert is running" : "Network transfer"}</span></div></div>}
      </div>}
    </div>
    <div className="table-card">
      <div className="table-card-header"><div><span className="eyebrow">DATABASE REGISTRY</span><h3>Available datasets</h3><p>Source rows and usable map records are tracked separately.</p></div><button className="icon-btn" onClick={() => void refresh()} aria-label="Refresh dataset registry"><RefreshCw size={16} /></button></div>
      <div className="dataset-list">{payload.datasets.length ? payload.datasets.map(d => <div className="dataset-row" key={d.id}><div className="dataset-category-icon"><Layers3 size={16} /></div><div className="dataset-ident"><strong>{d.name}</strong><span>{d.category} · {d.sourceType === "seed" ? "Project source" : "User upload"} · {d.source}</span></div><div className="dataset-count"><strong>{formatNumber(d.records)}</strong><span>source rows</span></div><div className="dataset-count"><strong>{formatNumber(d.mappedRecords)}</strong><span>mappable</span></div><span className={`dataset-status status-${d.status}`}>{d.status}</span><label className="toggle-switch" title={canManage?(d.active ? "Deactivate dataset" : "Activate dataset"):"Project owner only"}><input type="checkbox" disabled={!canManage || d.status !== "ready"} checked={d.active} onChange={e => void toggleDataset(d.id,e.target.checked)} /><span /></label>{canManage && d.sourceType === "upload" && <button className="icon-btn danger-icon" title="Delete uploaded dataset" onClick={() => void deleteDataset(d.id,d.name)}><Trash2 size={15} /></button>}</div>) : <div className="table-empty"><Database size={20} /><p>No datasets yet. Preloaded records will appear after the initial database bootstrap.</p></div>}</div>
    </div>
    <div className="table-card import-history-card"><div className="table-card-header"><div><span className="eyebrow">INGESTION LOG</span><h3>Recent import activity</h3></div><span className="history-count">{payload.imports.length} events</span></div><div className="history-list">{payload.imports.length ? payload.imports.slice(0,10).map(item => <div className="history-row" key={item.id}><span className={`history-status history-${item.status}`}><CheckCircle2 size={14} /></span><div><strong>{item.source}</strong><span>{item.category} · {formatDate(item.completedAt ?? item.startedAt)}</span></div><span>{formatNumber(item.recordsImported || item.recordsRead)} records</span><span className="status-text">{item.status}</span></div>) : <div className="table-empty"><p>No imports have been recorded.</p></div>}</div></div>
    <p className="data-disclaimer">Coordinates that fall within the numeric WGS84 range are not independently verified for CRS or positional accuracy. Disabled datasets remain in storage but are excluded from current summaries and map queries.</p>
  </div>;
}
