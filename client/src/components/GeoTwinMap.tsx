import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AttributionControl, GeoJSON, MapContainer, Rectangle, ScaleControl, useMap, useMapEvents, ZoomControl } from "react-leaflet";
import L from "leaflet";
import { maplibreGL } from "@maplibre/maplibre-gl-leaflet";
import { setWorkerUrl } from "maplibre-gl";
import mapLibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "leaflet/dist/leaflet.css";
import "maplibre-gl/dist/maplibre-gl.css";
import wellknown from "wellknown";
import type { Feature as GeoJsonFeature, FeatureCollection, Geometry } from "geojson";
import { Layers3, LocateFixed, LoaderCircle, MapPin } from "lucide-react";
import { apiJson, GEO_TWIN_AUTH_EXPIRED_EVENT, type Category, type GeoFeature } from "@/lib/geotwin-api";
import { categoryColor, defaultMapCategories, mapLayerOptions } from "@/lib/map-layers";

setWorkerUrl(mapLibreWorkerUrl);
const OPENFREEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";
const OPENFREEMAP_ATTRIBUTION = '<a href="https://openfreemap.org/" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> · © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener noreferrer">OpenMapTiles</a> · Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>';

export type BoundsBox = { west: number; east: number; south: number; north: number };
type MapCenter = { lat: number; lng: number };
type RegionExtent = { region: string; bounds: BoundsBox } | null;

function formatCoordinate(value: number, positive: string, negative: string) {
  return `${Math.abs(value).toFixed(4)}° ${value >= 0 ? positive : negative}`;
}

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
function OpenFreeMapBaseLayer() {
  const map = useMap();
  useEffect(() => {
    const layer = maplibreGL({ style: OPENFREEMAP_STYLE, attributionControl: { customAttribution: OPENFREEMAP_ATTRIBUTION } }).addTo(map);
    return () => { map.removeLayer(layer); };
  }, [map]);
  return null;
}
function MapStateListener({ onBounds, onCenter }: { onBounds: (bounds: BoundsBox) => void; onCenter: (center: MapCenter) => void }) {
  const map = useMap();
  const update = useCallback((target: L.Map) => {
    const rect = target.getContainer().getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const bounds = target.getBounds();
    const center = target.getCenter();
    onBounds({ west: bounds.getWest(), east: bounds.getEast(), south: bounds.getSouth(), north: bounds.getNorth() });
    onCenter({ lat: center.lat, lng: center.lng });
  }, [onBounds, onCenter]);
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
function FitRegionExtent({ token, region, extent }: { token: number; region: string; extent: BoundsBox | null }) {
  const map = useMap();
  const appliedToken = useRef(0);
  const bounds = useMemo(() => extent ? L.latLngBounds([[extent.south, extent.west], [extent.north, extent.east]]) : null, [extent]);
  useEffect(() => {
    if (!token || token === appliedToken.current || !bounds?.isValid()) return;
    appliedToken.current = token;
    map.stop();
    map.invalidateSize({ pan: false });
    map.fitBounds(bounds, { padding: [32, 32], maxZoom: 15, animate: true, duration: 0.55 });
  }, [token, bounds, map]);
  if (!region || !bounds?.isValid()) return null;
  return <Rectangle bounds={bounds} interactive={false} pathOptions={{ color: "#b36b56", weight: 2, opacity: 0.9, dashArray: "6 6", fillColor: "#b36b56", fillOpacity: 0.08, lineCap: "round", lineJoin: "round" }} />;
}

export default function GeoTwinMap({ region, search = "", fitToken, focusCategory, focusToken, onFeatures, onMissingLayerClick, className = "" }: Props) {
  const [layers, setLayers] = useState<Category[]>(defaultMapCategories);
  const [features, setFeatures] = useState<GeoFeature[]>([]);
  const [bounds, setBounds] = useState<BoundsBox | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sessionExpired, setSessionExpired] = useState(false);
  const [selected, setSelected] = useState<GeoFeature | null>(null);
  const [dataStatus, setDataStatus] = useState("");
  const [availableCategories, setAvailableCategories] = useState<Category[] | null>(null);
  const [regionExtent, setRegionExtent] = useState<RegionExtent>(null);
  const [regionFitToken, setRegionFitToken] = useState(0);
  const [mapCenter, setMapCenter] = useState<MapCenter>({ lat: 21.1458, lng: 79.0882 });
  const priorRegion = useRef(region);
  const fitRegionPending = useRef(Boolean(region));
  const retryController = useRef<AbortController | null>(null);

  const load = useCallback(async (box: BoundsBox | null, signal?: AbortSignal, fitRegion = false) => {
    if (!layers.length) { setLoading(false); setError(""); setSessionExpired(false); setFeatures([]); setDataStatus("All map layers are hidden."); onFeatures?.([]); return; }
    setLoading(true); setError(""); setSessionExpired(false);
    const params = new URLSearchParams({ categories: layers.join(","), region, search: search.trim() });
    if (fitRegion) params.set("fitRegion", "1");
    else if (box) Object.entries(box).forEach(([key, value]) => params.set(key, String(value)));
    try {
      const body = await apiJson<{ features: GeoFeature[]; count: number; loaded: number; truncated?: boolean; availableCategories?: Category[]; note?: string; extent?: BoundsBox | null }>(`/api/geotwin/features?${params}`, { signal });
      setFeatures(body.features);
      setAvailableCategories(body.availableCategories ?? []);
      onFeatures?.(body.features);
      if (fitRegion) {
        fitRegionPending.current = false;
        setRegionExtent(body.extent ? { region, bounds: body.extent } : null);
        setRegionFitToken(value => value + 1);
      }
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
    if (priorRegion.current === region) return;
    priorRegion.current = region;
    fitRegionPending.current = true;
    setBounds(null);
  }, [region]);

  useEffect(() => {
    const controller = new AbortController();
    const fitRegion = fitRegionPending.current;
    const timer = window.setTimeout(() => void load(bounds, controller.signal, fitRegion), 280);
    return () => { window.clearTimeout(timer); controller.abort(); retryController.current?.abort(); retryController.current = null; };
  }, [load, bounds]);

  const collection = useMemo(() => {
    const grouped: Record<string, GeoJsonFeature<Geometry, Record<string, unknown>>[]> = {};
    for (const record of features) {
      const geometry = geometryFromRecord(record);
      if (!geometry) continue;
      (grouped[record.category] ??= []).push({ type: "Feature", geometry, properties: { ...record.properties, _record: record, name: record.name, region: record.region, category: record.category } });
    }
    return Object.entries(grouped).map(([category, items]) => ({ category: category as Category, collection: { type: "FeatureCollection" as const, features: items } as FeatureCollection<Geometry, Record<string, unknown>> }));
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
  const centerCallback = useCallback((value: MapCenter) => setMapCenter(current => Math.abs(current.lat - value.lat) < 0.00001 && Math.abs(current.lng - value.lng) < 0.00001 ? current : value), []);
  const activeRegionExtent = regionExtent?.region === region ? regionExtent.bounds : null;
  const hidingUnassignedEnvironmentalRows = Boolean(region) && layers.some(category => ["Built-up", "Green cover", "Flood risk", "NDVI"].includes(category));

  return (
    <div className={`map-panel ${className}`}>
      <div className="map-titlebar">
        <div className="map-title"><span className="tiny-eye" /> <span>NAGPUR / DIGITAL CITY MODEL</span><span className="map-title-city">{region ? `${region} analytical region` : "Nagpur, Maharashtra"}</span></div>
        <div className="map-title-tools">
          <span className="map-status"><i className={error ? "status-dot dot-error" : "status-dot dot-live"} />{error ? "Data unavailable" : "Source records"}</span>
          <button className="icon-btn map-locate" title="Return to the Nagpur study center" aria-label="Return to Nagpur center" onClick={() => window.dispatchEvent(new CustomEvent("geotwin-map-center"))}><LocateFixed size={16} /></button>
        </div>
      </div>
      <div className="map-canvas-wrap">
        <MapContainer center={[21.1458, 79.0882]} zoom={12} minZoom={1} maxZoom={19} zoomControl={false} scrollWheelZoom className="map-canvas" preferCanvas>
          <OpenFreeMapBaseLayer />
          <AttributionControl position="bottomright" prefix={false} />
          <ZoomControl position="bottomright" />
          <ScaleControl position="bottomleft" metric imperial={false} />
          <MapStateListener onBounds={boundsCallback} onCenter={centerCallback} />
          <FitButton token={fitToken} features={features} />
          <FitRegionExtent token={regionFitToken} region={region} extent={activeRegionExtent} />
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
        <div className="map-overlay-top-left"><div className="map-coordinate"><span>MAP CENTER</span><strong>{formatCoordinate(mapCenter.lat, "N", "S")}&nbsp; · &nbsp;{formatCoordinate(mapCenter.lng, "E", "W")}</strong></div><span className="map-grid-tag">WGS84 / EPSG:4326*</span>{region && activeRegionExtent && <span className="map-grid-tag map-region-extent-tag"><i />{region} source-data extent · not an official boundary</span>}</div>
        <div className="map-layer-menu" aria-label="Toggle map layers">
          <div className="map-layers-label"><Layers3 size={14} /><span>LAYERS</span></div>
          {mapLayerOptions.map(layer => {
            const available = availableCategories === null || layer.categories.some(category => availableCategories.includes(category));
            const active = layer.categories.some(category => layers.includes(category));
            return <button type="button" key={layer.name} aria-pressed={active} className={`map-layer-chip ${active ? "is-active" : ""} ${!available ? "is-unavailable" : ""}`} onClick={() => available ? toggleLayer(layer.categories) : onMissingLayerClick?.()} title={available ? `Toggle ${layer.label}` : `${layer.label} is unavailable — open Data Management to upload records`}><span style={{ background: layer.color }} />{layer.label}<i /></button>;
          })}
        </div>
        {selected && <div className="feature-inspector"><button onClick={() => setSelected(null)} aria-label="Close feature details" className="inspector-close">×</button><span className="eyebrow">FEATURE RECORD · {selected.category}</span><strong>{selected.name || selected.category}</strong><span>{selected.region || "Region not provided"} · {selected.dataset}</span><small className="feature-source-file">{selected.sourceFile}</small><code>{selected.latitude.toFixed(5)}, {selected.longitude.toFixed(5)}</code><dl>{Object.entries(selected.properties ?? {}).slice(0, 4).map(([key, value]) => <div key={key}><dt>{key.replace(/_/g, " ")}</dt><dd>{String(value).slice(0, 76)}</dd></div>)}</dl></div>}
        {error && <div className="map-error" role="alert"><span>{error}</span><button onClick={() => {
          if (sessionExpired) { window.dispatchEvent(new Event(GEO_TWIN_AUTH_EXPIRED_EVENT)); return; }
          retryController.current?.abort();
          const controller = new AbortController();
          retryController.current = controller;
          void load(bounds, controller.signal, fitRegionPending.current);
        }}>{sessionExpired ? "Return to sign in" : "Retry"}</button></div>}
        {loading && <div className="map-loading"><LoaderCircle size={15} className="spin" /><span>Querying the visible extent…</span></div>}
        {!loading && !error && dataStatus && <div className="map-record-count"><MapPin size={12} />{dataStatus}</div>}
      </div>
      <div className="map-footer"><span><i className="source-dot" /> OpenFreeMap vector basemap · project-supplied GIS layers</span><span>{hidingUnassignedEnvironmentalRows ? `The ${region} filter excludes city-wide environmental samples without a matching region label; choose All regions to view them.` : "Pan or zoom to query another area"}</span></div>
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
