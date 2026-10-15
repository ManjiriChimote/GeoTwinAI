import { useCallback, useEffect, useMemo, useState } from "react";
import { AttributionControl, GeoJSON, MapContainer, ScaleControl, TileLayer, useMap, useMapEvents, ZoomControl } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import wellknown from "wellknown";
import type { Feature as GeoJsonFeature, FeatureCollection, Geometry } from "geojson";
import { Layers3, LocateFixed, LoaderCircle, MapPin } from "lucide-react";
import { apiJson, GEO_TWIN_AUTH_EXPIRED_EVENT, type Category, type GeoFeature } from "@/lib/geotwin-api";

const categoryColor: Record<string, string> = {
  Buildings: "#9b8068", Roads: "#527c8c", Hospitals: "#c66a5b", Schools: "#7287a0", Parks: "#778c69",
  "Water bodies": "#648fa0", "Green cover": "#829774", "Flood risk": "#c66a5b", "Built-up": "#867f76", NDVI: "#9aa969",
};
const supportedLayers: { name: string; categories: Category[]; label: string; color: string }[] = [
  { name: "Buildings", categories: ["Buildings", "Built-up"], label: "Buildings", color: categoryColor.Buildings },
  { name: "Roads", categories: ["Roads"], label: "Roads", color: categoryColor.Roads },
  { name: "Green", categories: ["Parks", "Green cover", "NDVI"], label: "Green", color: categoryColor["Green cover"] },
  { name: "Water", categories: ["Water bodies"], label: "Water", color: categoryColor["Water bodies"] },
  { name: "Risk", categories: ["Flood risk"], label: "Risk", color: categoryColor["Flood risk"] },
];
export type BoundsBox = { west: number; east: number; south: number; north: number };

type Props = {
  region: string;
  expanded?: boolean;
  search?: string;
  showControls?: boolean;
  className?: string;
  fitToken?: number;
  focusCategory?: Category;
  focusToken?: number;
  onFeatures?: (features: GeoFeature[]) => void;
  onMissingLayerClick?: () => void;
};

function geometryFromRecord(record: GeoFeature): Geometry | null {
  if (record.geometry?.trim()) {
    try {
      const parsed = wellknown.parse(record.geometry) as Geometry | null;
      if (parsed) return parsed;
    } catch {}
    try {
      const parsed = JSON.parse(record.geometry) as { type?: string; coordinates?: unknown };
      if (parsed.type && parsed.coordinates) return parsed as Geometry;
    } catch {}
  }
  return Number.isFinite(record.latitude) && Number.isFinite(record.longitude)
    ? { type: "Point", coordinates: [record.longitude, record.latitude] }
    : null;
}
function MapStateListener({ onBounds }: { onBounds: (bounds: BoundsBox) => void }) {
  const map = useMap();
  const update = useCallback((target: L.Map) => {
    const rect = target.getContainer().getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const bounds = target.getBounds();
    onBounds({ west: bounds.getWest(), east: bounds.getEast(), south: bounds.getSouth(), north: bounds.getNorth() });
  }, [onBounds]);
  useMapEvents({ moveend(e) { update(e.target as L.Map); }, zoomend(e) { update(e.target as L.Map); } });
  useEffect(() => {
    const container = map.getContainer();
    let frame = 0;
    const refresh = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (!container.isConnected) return;
        map.invalidateSize({ pan: false });
        update(map);
      });
    };
    refresh();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refresh);
    observer?.observe(container);
    window.addEventListener("orientationchange", refresh);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("orientationchange", refresh);
    };
  }, [map, update]);
  return null;
}
function FitButton({ token, features }: { token?: number; features: GeoFeature[] }) {
  const map = useMap();
  useEffect(() => {
    if (!token || !features.length) return;
    const points = features.filter(f => Number.isFinite(f.latitude) && Number.isFinite(f.longitude)).map(f => L.latLng(f.latitude, f.longitude));
    if (points.length) map.fitBounds(L.latLngBounds(points), { padding: [44, 44], maxZoom: 15, animate: true });
  }, [token, features, map]);
  return null;
}

export default function GeoTwinMap({ region, search = "", fitToken, focusCategory, focusToken, onFeatures, onMissingLayerClick, className = "" }: Props) {
  const [layers, setLayers] = useState<Category[]>(["Buildings", "Built-up", "Roads", "Parks", "Green cover", "NDVI", "Water bodies", "Flood risk"]);
  const [features, setFeatures] = useState<GeoFeature[]>([]);
  const [bounds, setBounds] = useState<BoundsBox | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sessionExpired, setSessionExpired] = useState(false);
  const [selected, setSelected] = useState<GeoFeature | null>(null);
  const [dataStatus, setDataStatus] = useState("");
  const [availableCategories, setAvailableCategories] = useState<Category[] | null>(null);

  const load = useCallback(async (box: BoundsBox | null, signal?: AbortSignal) => {
    if (!layers.length) { setFeatures([]); setDataStatus("All map layers are hidden."); onFeatures?.([]); return; }
    setLoading(true); setError(""); setSessionExpired(false);
    const params = new URLSearchParams({ categories: layers.join(","), region, search: search.trim() });
    if (box) Object.entries(box).forEach(([key, value]) => params.set(key, String(value)));
    try {
      const body = await apiJson<{ features: GeoFeature[]; count: number; loaded: number; truncated?: boolean; availableCategories?: Category[]; note?: string }>(`/api/geotwin/features?${params}`, { signal });
      setFeatures(body.features);
      setAvailableCategories(body.availableCategories ?? []);
      onFeatures?.(body.features);
      setDataStatus(body.truncated ? `Showing ${body.loaded.toLocaleString()} of ${body.count.toLocaleString()} records in this extent · zoom in for detail` : body.count ? `${body.count.toLocaleString()} records in this view` : "No records in this view");
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        const message = e instanceof Error ? e.message : "The map data could not be loaded.";
        const needsLogin = /sign in|session.*(expired|missing)|no active geotwinai account/i.test(message);
        setSessionExpired(needsLogin);
        setError(needsLogin ? "Your private data session has ended. Sign in again to reload map features." : message);
      }
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [layers, onFeatures, region, search]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(bounds, controller.signal), 280);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load, bounds]);

  const collection = useMemo(() => {
    const grouped: Record<string, GeoJsonFeature<Geometry, Record<string, unknown>>[]> = {};
    for (const record of features) {
      const geometry = geometryFromRecord(record);
      if (!geometry) continue;
      (grouped[record.category] ??= []).push({ type: "Feature", geometry, properties: { ...record.properties, _record: record, name: record.name, region: record.region, category: record.category } });
    }
    return Object.entries(grouped).map(([category, items]) => ({ category, collection: { type: "FeatureCollection" as const, features: items } as FeatureCollection<Geometry, Record<string, unknown>> }));
  }, [features]);

  useEffect(() => {
    if (!focusCategory) return;
    setLayers(prev => prev.includes(focusCategory) ? prev : [...prev, focusCategory]);
  }, [focusCategory, focusToken]);
  const toggleLayer = (categories: Category[]) => setLayers(prev => {
    const allOn = categories.every(category => prev.includes(category));
    return allOn ? prev.filter(value => !categories.includes(value)) : [...new Set([...prev, ...categories])];
  });
  const boundsCallback = useCallback((value: BoundsBox) => setBounds(current => {
    if (!current) return value;
    const delta = [Math.abs(current.west - value.west), Math.abs(current.east - value.east), Math.abs(current.south - value.south), Math.abs(current.north - value.north)];
    return Math.max(...delta) < 0.0002 ? current : value;
  }), []);
  const showingCitywideEnvironmentalRows = Boolean(region) && layers.some(category => ["Built-up", "Green cover", "Flood risk", "NDVI"].includes(category));

  return (
    <div className={`map-panel ${className}`}>
      <div className="map-titlebar">
        <div className="map-title"><span className="tiny-eye" /> <span>NAGPUR / DIGITAL CITY MODEL</span><span className="map-title-city">Nagpur, Maharashtra</span></div>
        <div className="map-title-tools">
          <span className="map-status"><i className={error ? "status-dot dot-error" : "status-dot dot-live"} />{error ? "Data unavailable" : "Source records"}</span>
          <button className="icon-btn map-locate" title="Return to the Nagpur study center" aria-label="Return to Nagpur center" onClick={() => window.dispatchEvent(new CustomEvent("geotwin-map-center"))}><LocateFixed size={16} /></button>
        </div>
      </div>
      <div className="map-canvas-wrap">
        <MapContainer center={[21.1458, 79.0882]} zoom={12} zoomControl={false} scrollWheelZoom className="map-canvas" preferCanvas>
          <TileLayer
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>'
            maxZoom={19}
            detectRetina
          />
          <AttributionControl position="bottomright" prefix={false} />
          <ZoomControl position="bottomright" />
          <ScaleControl position="bottomleft" metric imperial={false} />
          <MapStateListener onBounds={boundsCallback} />
          <FitButton token={fitToken} features={features} />
          <MapHomeControls />
          {collection.map(({ category, collection: data }) => (
            <GeoJSON key={category} data={data} style={() => ({ color: categoryColor[category] ?? "#527c8c", weight: category === "Roads" ? 2.1 : 1.2, opacity: category === "Roads" ? 0.64 : 0.75, fillColor: categoryColor[category] ?? "#527c8c", fillOpacity: category === "Flood risk" ? 0.18 : 0.28 })}
              pointToLayer={(_feature, latlng) => L.circleMarker(latlng, { radius: category === "Buildings" ? 2.7 : category === "Hospitals" ? 5.5 : 4.2, color: "#f7f4ec", weight: category === "Hospitals" ? 1.8 : 0.8, fillColor: categoryColor[category] ?? "#527c8c", fillOpacity: 0.88 })}
              onEachFeature={(feature, layer) => {
                const item = feature.properties?._record as GeoFeature | undefined;
                const popup = document.createElement("div");
                const title = document.createElement("strong"); title.textContent = item?.name || category; popup.appendChild(title);
                const info = document.createElement("div"); info.textContent = `${item?.region || "Region not provided"} · ${item?.dataset || category} · ${item?.sourceFile || "Source file unavailable"}`; popup.appendChild(info);
                layer.bindPopup(popup, { maxWidth: 280 });
                layer.on("click", () => setSelected(item ?? null));
              }} />
          ))}
        </MapContainer>
        <div className="map-overlay-top-left"><div className="map-coordinate"><span>STUDY CENTER</span><strong>21°08′45″ N&nbsp; · &nbsp;79°05′18″ E</strong></div><span className="map-grid-tag">WGS84 / EPSG:4326*</span></div>
        <div className="map-layer-menu" aria-label="Toggle map layers">
          <div className="map-layers-label"><Layers3 size={14} /><span>LAYERS</span></div>
          {supportedLayers.map(layer => {
            const available = availableCategories === null || layer.categories.some(category => availableCategories.includes(category));
            const active = layer.categories.some(category => layers.includes(category));
            return <button type="button" key={layer.name} aria-pressed={active} className={`map-layer-chip ${active ? "is-active" : ""} ${!available ? "is-unavailable" : ""}`} onClick={() => available ? toggleLayer(layer.categories) : onMissingLayerClick?.()} title={available ? `Toggle ${layer.label}` : `${layer.label} is unavailable — open Data Management to upload records`}><span style={{ background: layer.color }} />{layer.label}<i /></button>;
          })}
        </div>
        {selected && <div className="feature-inspector"><button onClick={() => setSelected(null)} aria-label="Close feature details" className="inspector-close">×</button><span className="eyebrow">FEATURE RECORD · {selected.category}</span><strong>{selected.name || selected.category}</strong><span>{selected.region || "Region not provided"} · {selected.dataset}</span><small className="feature-source-file">{selected.sourceFile}</small><code>{selected.latitude.toFixed(5)}, {selected.longitude.toFixed(5)}</code><dl>{Object.entries(selected.properties ?? {}).slice(0, 4).map(([key, value]) => <div key={key}><dt>{key.replace(/_/g, " ")}</dt><dd>{String(value).slice(0, 76)}</dd></div>)}</dl></div>}
        {error && <div className="map-error" role="alert"><span>{error}</span><button onClick={() => sessionExpired ? window.dispatchEvent(new Event(GEO_TWIN_AUTH_EXPIRED_EVENT)) : void load(bounds)}>{sessionExpired ? "Return to sign in" : "Retry"}</button></div>}
        {loading && <div className="map-loading"><LoaderCircle size={15} className="spin" /><span>Querying the visible extent…</span></div>}
        {!loading && !error && dataStatus && <div className="map-record-count"><MapPin size={12} />{dataStatus}</div>}
      </div>
      <div className="map-footer"><span><i className="source-dot" /> OpenStreetMap basemap · project-supplied GIS layers</span><span>{showingCitywideEnvironmentalRows ? "City-wide environmental samples remain separate from analytical region records." : "Pan or zoom to query another area"}</span></div>
    </div>
  );
}

function MapHomeControls() {
  const map = useMap();
  useEffect(() => {
    const reset = () => map.flyTo([21.1458, 79.0882], 12, { duration: 0.6 });
    window.addEventListener("geotwin-map-center", reset);
    return () => window.removeEventListener("geotwin-map-center", reset);
  }, [map]);
  return null;
}
