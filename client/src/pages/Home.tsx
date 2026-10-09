import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, ArrowDownToLine, ArrowRight, BarChart3, BookOpenText, Building2, CheckCircle2, ChevronDown, ChevronRight,
  CircleHelp, Compass, Database, Download, FileText, Flower2, Layers2, Leaf, Map as MapIcon, MapPinned, Menu,
  Copy, LogOut, MessageSquareText, PanelLeftClose, RefreshCw, Search, Settings2, ShieldAlert, Sparkles, Waves, X, Zap,
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import GeoTwinMap from "@/components/GeoTwinMap";
import DataImportPanel from "@/components/DataImportPanel";
import GeoAssistant from "@/components/GeoAssistant";
import { apiJson, formatDate, formatNumber, type Category, type Dataset, type GeoAction, type Page, type Region, type Summary } from "@/lib/geotwin-api";

const regions: Region[] = ["North", "South", "East", "West", "Central"];
const primaryPages: { title: Page; icon: typeof MapIcon; caption: string }[] = [
  { title: "Overview", icon: MapIcon, caption: "The city, in context" },
  { title: "Explore", icon: Compass, caption: "Search & inspect" },
  { title: "Analyze", icon: BarChart3, caption: "Find the shape of it" },
  { title: "Intelligence", icon: Sparkles, caption: "Signals & next steps" },
  { title: "Report", icon: FileText, caption: "Build an evidence note" },
];

type AnalysisResult = Record<string, unknown>;
type ReportIndicator = "source" | "mapped" | "coverage";
type Report = { reportDate: string; region: string; indicators: ReportIndicator[]; records: { datasetKey: string; dataset: string; source: string; category: string; region: string; records: number; mapped: number; coveragePercent: number | null }[]; methodology: string; limitations: string; sourceDatasets: string[]; sourceFiles: string[] };
const reportIndicatorOptions: { key: ReportIndicator; label: string }[] = [
  { key: "source", label: "Stored feature rows" },
  { key: "mapped", label: "Mappable records" },
  { key: "coverage", label: "Coordinate coverage" },
];
const satelliteSpecs = [
  { label: "Sentinel-2 NDVI", category: "NDVI", sourceKey: "sentinel2_ndvi", mapped: true },
  { label: "Green cover", category: "Green cover", sourceKey: "greencover", mapped: true },
  { label: "Built-up sample", category: "Built-up", sourceKey: "builtup", mapped: true },
  { label: "Flood-risk sample", category: "Flood risk", sourceKey: "floodrisk", mapped: true },
  { label: "Heat summary", category: null, sourceKey: "heatmap", mapped: false },
  { label: "Land-cover summary", category: null, sourceKey: "lulc_summary", mapped: false },
] as const;

function emptySummary(): Summary {
  return { center: { latitude: 21.1458, longitude: 79.0882 }, regions, coreCategories: ["Buildings","Roads","Hospitals","Schools","Parks","Water bodies"], categories: [], datasets: [], counts: {}, regionalCounts: {}, metrics: [], quality: { total: 0, mapped: 0, datasets: 0 }, provenance: "" };
}
function text(value: unknown, fallback = "—") { return value === undefined || value === null || value === "" ? fallback : String(value); }
function pct(value: number, max: number) { return max ? Math.round(100 * value / max) : 0; }

type HomeProps = { accountName: string; accountEmail: string; accountOpenId: string; onLogout: () => Promise<void> };

export default function Home({ accountName, accountEmail, accountOpenId, onLogout }: HomeProps) {
  const [page, setPage] = useState<Page>("Overview");
  const [region, setRegion] = useState<Region>("Central");
  const [summary, setSummary] = useState<Summary>(emptySummary());
  const [error, setError] = useState("");
  const [databaseReady, setDatabaseReady] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [canManage, setCanManage] = useState(false);
  const [ownerSetupRequired, setOwnerSetupRequired] = useState(false);
  const [accessNote, setAccessNote] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [hideRail, setHideRail] = useState(false);
  const [exploreSearch, setExploreSearch] = useState("");
  const [focusCategory, setFocusCategory] = useState<Category | undefined>();
  const [mapFitToken, setMapFitToken] = useState(0);
  const [mapFocusToken, setMapFocusToken] = useState(0);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analysisType, setAnalysisType] = useState("regional");
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState("");
  const [reportDatasetKeys, setReportDatasetKeys] = useState<string[]>([]);
  const [reportIndicators, setReportIndicators] = useState<ReportIndicator[]>(["source", "mapped", "coverage"]);

  const refreshData = useCallback(async () => {
    try {
      const [data, health] = await Promise.all([
        apiJson<Summary>("/api/geotwin/summary"),
        apiJson<{ database: boolean; seeded: boolean; records: number; initializing?: boolean; canManage?: boolean; ownerSetupRequired?: boolean }>("/api/geotwin/status"),
      ]);
      setSummary(data); setDatabaseReady(health.database); setInitializing(Boolean(health.initializing)); setCanManage(Boolean(health.canManage)); setOwnerSetupRequired(Boolean(health.ownerSetupRequired)); setError("");
      return health;
    } catch (e) { setError(e instanceof Error ? e.message : "GeoTwinAI is waiting for its data service."); setDatabaseReady(false); return null; }
  }, []);

  useEffect(() => { void refreshData(); }, [refreshData]);
  useEffect(() => {
    if (!initializing) return;
    const timer = window.setInterval(() => { void refreshData(); }, 3200);
    return () => window.clearInterval(timer);
  }, [initializing, refreshData]);

  const runAnalysis = useCallback(async (type = analysisType) => {
    setAnalysisBusy(true); setAnalysisError("");
    try { setAnalysis(await apiJson<AnalysisResult>("/api/geotwin/analyze", { method: "POST", body: JSON.stringify({ type, region: region === "All regions" ? undefined : region }) })); }
    catch (e) { setAnalysisError(e instanceof Error ? e.message : "Analysis could not be computed."); }
    finally { setAnalysisBusy(false); }
  }, [analysisType, region]);
  useEffect(() => { if (page === "Analyze" || page === "Intelligence") void runAnalysis(page === "Intelligence" ? "regional" : analysisType); }, [page, region, analysisType, runAnalysis]);

  const refreshReport = useCallback(async () => {
    setReportBusy(true); setReportError("");
    try { setReport(await apiJson<Report>("/api/geotwin/report", { method: "POST", body: JSON.stringify({ region: region === "All regions" ? undefined : region, datasetKeys: reportDatasetKeys, indicators: reportIndicators }) })); }
    catch (e) { setReportError(e instanceof Error ? e.message : "The report could not be generated."); }
    finally { setReportBusy(false); }
  }, [region, reportDatasetKeys, reportIndicators]);
  useEffect(() => { if (page === "Report") void refreshReport(); }, [page, refreshReport]);

  const activeDatasets = useMemo(() => summary.datasets.filter(d => d.status === "ready" && d.active), [summary.datasets]);
  const coreTotals = useMemo(() => summary.coreCategories.map(category => ({ category, records: summary.counts[category]?.records ?? 0, mapped: summary.counts[category]?.mapped ?? 0 })), [summary]);
  const regionalData = useMemo(() => regions.map(key => ({ region: key, hospitals: summary.regionalCounts[key]?.Hospitals ?? 0, schools: summary.regionalCounts[key]?.Schools ?? 0, parks: summary.regionalCounts[key]?.Parks ?? 0, total: Object.values(summary.regionalCounts[key] ?? {}).reduce((a,b)=>a+b,0) })), [summary]);
  const environmentalSnapshots = useMemo(() => satelliteSpecs.flatMap(spec => {
    const metadata = summary.metrics.find(metric => metric.source.toLowerCase().includes(spec.sourceKey))?.value as { records?: Record<string, unknown>[] } | undefined;
    const values = metadata?.records?.[0];
    if (!values) return [];
    const get = (...keys: string[]) => keys.map(key => values[key]).find(value => value !== undefined && value !== null && String(value).trim() !== "");
    const num = (value: unknown, digits = 2) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed.toFixed(digits) : ""; };
    const observation = get("Scene_Date", "Before_Date", "Date");
    const after = get("After_Date");
    const source = String(get("Data_Source", "Source", "Satellite", "Product") ?? "Supplied source summary");
    let finding = "";
    if (spec.sourceKey === "sentinel2_ndvi") { const mean = get("NDVI_Mean"); if (mean !== undefined) finding = `Mean NDVI ${num(mean, 3)}`; }
    if (spec.sourceKey === "greencover") { const percent = get("Green_Cover_Percent"); if (percent !== undefined) finding = `${num(percent)}% source-reported green cover`; }
    if (spec.sourceKey === "builtup") { const percent = get("BuiltUp_Percentage"); if (percent !== undefined) finding = `${num(percent)}% source-reported built-up`; }
    if (spec.sourceKey === "floodrisk") { const score = get("Mean_Flood_Risk_Score"); if (score !== undefined) finding = `Mean source risk score ${num(score)}`; }
    if (spec.sourceKey === "heatmap") { const temperature = get("Mean_Temperature_C"); if (temperature !== undefined) finding = `Source mean ${num(temperature)} °C`; }
    if (spec.sourceKey === "lulc_summary") { const classes = (metadata?.records ?? []).filter(row => row.LULC_Class); const leading = classes.sort((a,b)=>Number(b.Percentage??0)-Number(a.Percentage??0))[0]; if (leading) finding = `${String(leading.LULC_Class)} · ${num(leading.Percentage)}% in source summary`; }
    const count = spec.category ? summary.datasets.filter(dataset => dataset.category === spec.category && dataset.active && dataset.status === "ready").reduce((total,dataset)=>total+dataset.records,0) : null;
    const date = observation && after ? `${formatDate(String(observation))} – ${formatDate(String(after))}` : observation ? formatDate(String(observation)) : "Date not provided";
    return [{ label: spec.label, category: spec.category, count, date, source, finding, sourceRows: metadata?.records?.length ?? 0, mapped: spec.mapped, sourceOnly: !spec.mapped, scope: String(get("Region") ?? "Nagpur project study area") }];
  }), [summary]);
  const inventory = summary.datasets.reduce((sum, d) => sum + (d.active && d.status === "ready" ? d.records : 0), 0);
  const mapped = summary.quality.mapped;
  const mapLayers = (category: Category) => { setFocusCategory(category); setMapFocusToken(v=>v+1); if (page !== "Explore") setPage("Explore"); setMapFitToken(v => v + 1); };
  const assistantAction = (action: GeoAction) => {
    if (!action) return;
    if (action.type === "layer") { setFocusCategory(action.category); setMapFocusToken(v=>v+1); setPage("Explore"); setMapFitToken(v => v + 1); }
    else { setPage(action.section); if (action.section === "Analyze") void runAnalysis("regional"); }
  };

  const downloadCsv = () => {
    if (!report) return;
    const indicatorLabels: Record<ReportIndicator,string> = { source: "Stored feature rows", mapped: "Mappable records", coverage: "Coordinate coverage (%)" };
    const rows = [["Dataset","Source file","Category","Region",...report.indicators.map(key=>indicatorLabels[key])], ...report.records.map(item => [item.dataset,item.source,item.category,item.region,...report.indicators.map(key=>key==="source"?String(item.records):key==="mapped"?String(item.mapped):item.coveragePercent===null?"":item.coveragePercent.toFixed(1))])];
    rows.push([]); rows.push(["Report date",new Date(report.reportDate).toLocaleDateString("en-IN")]); rows.push(["Methodology",report.methodology]); rows.push(["Limitations",report.limitations]);
    const safeCell = (s: string) => { const value = String(s ?? "").replace(/\u0000/g, ""); const formulaSafe = /^[ \t\r]*[=+\-@]/.test(value) ? `'${value}` : value; return `"${formulaSafe.replace(/"/g,'""')}"`; };
    const csv = rows.map(row => row.map(s => safeCell(s ?? "")).join(",")).join("\r\n");
    const a = document.createElement("a"); const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" })); a.href = url; a.download = `geotwinai-${region.toLowerCase()}-report.csv`; a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 3000);
  };

  const downloadPdf = async () => {
    if (!report) return;
    const { jsPDF } = await import("jspdf");
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    doc.setFillColor(245,242,233); doc.rect(0,0,pageWidth,154,"F");
    doc.setTextColor(82,124,140); doc.setFont("helvetica","bold"); doc.setFontSize(9); doc.text("GEOTWINAI  /  PHYSICAL DIGITAL TWIN",46,47);
    doc.setTextColor(48,50,56); doc.setFontSize(24); doc.text("Nagpur · Evidence note",46,84);
    doc.setFont("helvetica","normal"); doc.setFontSize(11); doc.text(`${report.region}  ·  ${new Date(report.reportDate).toLocaleDateString("en-IN")}`,46,108);
    doc.setFontSize(8); doc.setTextColor(112,108,100); doc.text("Observed records from active, imported source datasets",46,128);
    let y = 190; doc.setTextColor(48,50,56); doc.setFont("helvetica","bold"); doc.setFontSize(8);
    const labelMap: Record<ReportIndicator,string> = { source: "STORED ROWS", mapped: "MAPPABLE", coverage: "COVERAGE %" };
    const columns = [{ key: "dataset", label: "DATASET", width: 158 }, { key: "region", label: "REGION", width: 90 }, ...report.indicators.map(key=>({key,label:labelMap[key],width:(pageWidth-92-248)/report.indicators.length}))];
    const positions = columns.map((column,index)=>columns.slice(0,index).reduce((sum,item)=>sum+item.width,46));
    columns.forEach((column,index)=>doc.text(column.label,positions[index],y));
    y+=13; doc.setDrawColor(217,210,196); doc.line(46,y,pageWidth-46,y); y+=20; doc.setFont("helvetica","normal"); doc.setFontSize(8);
    for (const row of report.records) { if(y>720){doc.addPage();y=64;} const rowValues: Record<string,string> = { dataset: row.dataset, region: row.region, source: formatNumber(row.records), mapped: formatNumber(row.mapped), coverage: row.coveragePercent===null?"—":row.coveragePercent.toFixed(1) }; columns.forEach((column,index)=>doc.text(rowValues[column.key].slice(0,26),positions[index],y)); y += 20; }
    y+=20; doc.setFont("helvetica","bold"); doc.setFontSize(10); doc.text("Method",46,y); y+=16; doc.setFont("helvetica","normal"); doc.setFontSize(9); const methodLines=doc.splitTextToSize(report.methodology,pageWidth-92); doc.text(methodLines,46,y); y+=methodLines.length*12+20;
    if(y>680){doc.addPage();y=64;} doc.setFont("helvetica","bold"); doc.text("Limitations",46,y); y+=16; doc.setFont("helvetica","normal"); const limitationLines=doc.splitTextToSize(report.limitations,pageWidth-92); doc.text(limitationLines,46,y); y+=limitationLines.length*11+18;
    if(y>720){doc.addPage();y=64;} doc.setFont("helvetica","bold"); doc.setFontSize(9); doc.text("SOURCE FILES",46,y); y+=14; doc.setFont("helvetica","normal"); doc.setFontSize(8); const sourceLines=doc.splitTextToSize(report.sourceFiles.join(", ")||"No active source file matched this selection.",pageWidth-92); doc.text(sourceLines,46,y);
    doc.save(`GeoTwinAI-${region.replace(/\s/g,"-")}-evidence-note.pdf`);
  };

  const toggleReportDataset = (key: string) => setReportDatasetKeys(current => { const allKeys=activeDatasets.map(dataset=>dataset.key); const base=current.length?current:allKeys; const next=base.includes(key)?base.filter(item=>item!==key):[...base,key]; return next.length===allKeys.length?[]:next; });
  const toggleReportIndicator = (indicator: ReportIndicator) => setReportIndicators(v => v.includes(indicator) ? (v.length > 1 ? v.filter(item => item !== indicator) : v) : [...v, indicator]);
  const copyOwnerIdentity = async () => { try { await navigator.clipboard.writeText(accountOpenId); setAccessNote("Account identifier copied. Paste it only into the protected project settings card."); } catch { window.prompt("Copy your account identifier directly into the protected project settings card. Do not paste it into chat.", accountOpenId); } };
  const navigate = (next: Page) => { setPage(next); setMobileNav(false); setExploreSearch(""); };

  const SectionTitle = ({ label, title, copy, action }: { label: string; title: string; copy?: string; action?: React.ReactNode }) => <div className="section-head"><div><span className="eyebrow">{label}</span><h1>{title}</h1>{copy && <p>{copy}</p>}</div>{action}</div>;
  const RegionControls = ({ isMobile = false }: { isMobile?: boolean }) => <div className={`region-list ${isMobile ? "region-list-mobile" : ""}`}>{regions.map((item,index)=><button key={item} className={`region-button ${region===item?"is-selected":""}`} onClick={()=>setRegion(item)}><span className="region-index">0{index+1}</span><span>{item}</span>{region===item&&<i />}</button>)}</div>;

  return <main className={`geotwin-shell ${hideRail ? "rail-collapsed" : ""}`}>
    <aside className={`side-rail ${mobileNav?"mobile-open":""}`}>
      <div className="brand-lockup"><img src="/geotwin-mark.svg" alt=""/><div><strong>GeoTwin<span>AI</span></strong><small>THE LIVING MODEL OF NAGPUR</small></div><button className="rail-close" onClick={()=>setMobileNav(false)} aria-label="Close navigation"><X size={17}/></button></div>
      <div className="rail-divider" />
      <div className="region-section"><div className="rail-heading"><span>ANALYTICAL REGIONS</span><span className="region-total">05</span></div><RegionControls /></div>
      <nav className="main-nav" aria-label="Primary navigation"><div className="rail-heading"><span>WORKSPACE</span></div>{primaryPages.map(({title,icon:Icon,caption})=><button key={title} className={`nav-item ${page===title?"active":""}`} onClick={()=>navigate(title)}><span className="nav-icon"><Icon size={18}/></span><span className="nav-copy"><strong>{title}</strong><small>{caption}</small></span>{page===title&&<i className="nav-indicator"/>}</button>)}</nav>
      <div className="rail-secondary"><div className="rail-heading"><span>WORKSPACE TOOLS</span></div><button className={`nav-item ${page==="Data Management"?"active":""}`} onClick={()=>navigate("Data Management")}><span className="nav-icon"><Database size={17}/></span><span className="nav-copy"><strong>Data Management</strong><small>Sources &amp; quality</small></span>{page==="Data Management"&&<i className="nav-indicator"/>}</button><button className={`nav-item ${page==="Settings"?"active":""}`} onClick={()=>navigate("Settings")}><span className="nav-icon"><Settings2 size={17}/></span><span className="nav-copy"><strong>Settings</strong><small>Project &amp; provenance</small></span>{page==="Settings"&&<i className="nav-indicator"/>}</button></div>
      <div className="rail-bottom"><div className="rail-mini-card"><span className="eyebrow">MAP AREA</span><strong>Nagpur Urban Region</strong><small>21.1458° N&nbsp; 79.0882° E</small><div className="mini-grid"><span>WGS84</span><span>PROJECT DATA</span></div></div><div className="db-status"><i className={`status-dot ${databaseReady?"dot-live":"dot-pending"}`}/><span>{databaseReady?"PERSISTENT DATABASE":"CONNECTING TO DATABASE"}</span><button className="icon-btn rail-help" title="About the project" onClick={()=>navigate("Settings")}><CircleHelp size={15}/></button></div></div>
    </aside>
    {mobileNav&&<button className="mobile-scrim" aria-label="Close navigation" onClick={()=>setMobileNav(false)}/>}
    <section className="work-area">
      <header className="topbar"><div className="topbar-leading"><button className="icon-btn mobile-menu" onClick={()=>setMobileNav(true)} aria-label="Open navigation"><Menu size={20}/></button><button className="icon-btn collapse-rail" title={hideRail?"Show sidebar":"Hide sidebar"} aria-label={hideRail?"Show sidebar":"Hide sidebar"} onClick={()=>setHideRail(v=>!v)}><PanelLeftClose size={17}/></button><span className="topbar-label">PHYSICAL DIGITAL TWIN</span><span className="topbar-dot"/><span className="topbar-tagline">OBSERVE&nbsp; · &nbsp;EXPLORE&nbsp; · &nbsp;UNDERSTAND</span></div><div className="topbar-tools"><span className="sync-status"><i className={`status-dot ${initializing?"dot-pending":"dot-live"}`}/>{initializing?"SYNCING SOURCE RECORDS":databaseReady?"DATABASE CONNECTED":"DATABASE OFFLINE"}</span><button className="outline-btn new-analysis" onClick={()=>{navigate("Analyze");void runAnalysis("regional");}}><Activity size={15}/>New analysis</button><button className="account-role-pill" onClick={()=>navigate("Settings")} title={`Signed in as ${accountName}`}>{canManage?"PROJECT OWNER":"READ ONLY"}</button><button className="icon-btn signout-btn" onClick={()=>void onLogout()} aria-label={`Sign out ${accountName}`} title="Sign out"><LogOut size={16}/></button></div></header>
      <div className="workspace-scroll"><div className="workspace-inner">
        {error && !databaseReady && <div className="global-notice"><Database size={16}/><span>{initializing?"The source registry is loading. The map will fill as records arrive.":error}</span><button onClick={()=>void refreshData()}><RefreshCw size={14}/>Retry</button></div>}

        {page==="Overview"&&<>
          <SectionTitle label="NAGPUR · ACTIVE VIEW" title="A city, in layers." copy="Look closely at the systems already on the map. A measured picture of the city — and the confidence behind each layer." action={<button className="text-link" onClick={()=>navigate("Explore")}>Explore the map <ArrowRight size={15}/></button>} />
          <div className="metrics-strip"><Metric icon={<Building2/>} label="BUILDING RECORDS" value={summary.counts.Buildings?.records??0} sub={`${formatNumber(summary.counts.Buildings?.mapped??0)} with map coordinates`} loading={initializing}/><Metric icon={<Layers2/>} label="ROAD FEATURES" value={summary.counts.Roads?.records??0} sub="Source line features · length not estimated" loading={initializing}/><Metric icon={<Zap/>} label="MAPPED FACILITIES" value={(summary.counts.Hospitals?.mapped??0)+(summary.counts.Schools?.mapped??0)} sub={`${formatNumber(summary.counts.Hospitals?.mapped??0)} mapped hospitals · ${formatNumber(summary.counts.Schools?.mapped??0)} mapped schools`} loading={initializing}/><Metric icon={<Leaf/>} label="GREEN + WATER" value={(summary.counts.Parks?.mapped??0)+(summary.counts["Green cover"]?.mapped??0)+(summary.counts["Water bodies"]?.mapped??0)} sub={`${formatNumber(summary.counts.Parks?.mapped??0)} parks · ${formatNumber(summary.counts["Green cover"]?.mapped??0)} green-cover cells · ${formatNumber(summary.counts["Water bodies"]?.mapped??0)} water bodies`} loading={initializing}/></div>
          <div className="overview-grid"><div className="overview-map-col"><GeoTwinMap region={region==="All regions"?"":region} fitToken={mapFitToken} focusCategory={focusCategory} focusToken={mapFocusToken} onMissingLayerClick={()=>navigate("Data Management")} className="overview-map"/><div className="overview-map-caption"><span><i className="status-dot dot-live"/> {formatNumber(inventory)} active source records</span><button onClick={()=>navigate("Data Management")}>Source &amp; quality details <ArrowRight size={13}/></button></div></div><div className="overview-aside"><article className="design-note"><span className="eyebrow">DESIGN LANGUAGE</span><h2>Like an architectural<br/>model, not a game.</h2><p>Warm paper, graphite, muted blue, olive and terracotta accents. Fine grid lines and contour references connect the interface to physical maps and urban models.</p><div className="design-note-footer"><span><i className="contour-dot"/>MEASURED, NOT ASSUMED</span><span>01 — 05</span></div></article><article className="story-note"><span className="eyebrow">THE STORY</span><p>Data enters the twin, spatial analysis gives it meaning, AI helps interpret patterns, and the user makes the planning decision.</p><div className="story-links"><button onClick={()=>navigate("Analyze")}>Explore an analysis <ArrowRight size={13}/></button><button onClick={()=>navigate("Intelligence")}>Open Geo intelligence <ArrowRight size={13}/></button></div></article></div></div>
          <div className="overview-foot"><div className="overview-foot-copy"><span className="eyebrow">A STUDY AREA, NOT A BOUNDARY CLAIM</span><p>Data reflect the supplied Nagpur project area and its source files. {formatNumber(mapped)} of {formatNumber(summary.quality.total)} active feature rows have map coordinates{summary.quality.total?` (${Math.round(100*mapped/summary.quality.total)}%)`:""}. Region labels are analytical; authoritative municipal coverage should be checked before using results in planning.</p></div><div className="overview-foot-side"><span className="mini-live"><i className="status-dot dot-live"/>{databaseReady?"PERSISTENT DATA CONNECTED":"DATA LOADING"}</span><button className="text-link" onClick={()=>navigate("Data Management")}>Inspect the data <ArrowRight size={14}/></button></div></div>
        </>}

        {page==="Explore"&&<>
          <SectionTitle label="EXPLORE · SOURCE RECORDS" title="Read the map." copy="Move through the city and inspect the features behind each pattern." action={<button className="secondary-btn" onClick={()=>setMapFitToken(v=>v+1)}><MapPinned size={15}/>Fit available records</button>} />
          <div className="explore-controls"><div className="search-field"><Search size={16}/><input value={exploreSearch} onChange={e=>setExploreSearch(e.target.value)} placeholder="Search names, categories or source fields…"/><kbd>/</kbd></div><div className="filter-hint"><span>{region} region</span><i/>{formatNumber(activeDatasets.length)} active datasets</div><button className="soft-filter" onClick={()=>setRegion(region==="All regions"?"Central":"All regions")}><Layers2 size={14}/>{region==="All regions"?"Central region":"All regions"}<ChevronDown size={13}/></button></div>
          <GeoTwinMap region={region==="All regions"?"":region} search={exploreSearch} fitToken={mapFitToken} focusCategory={focusCategory} focusToken={mapFocusToken} onMissingLayerClick={()=>navigate("Data Management")} className="explore-map" />
          <div className="explore-bottom"><div><span className="eyebrow">INSPECT A FEATURE</span><p>Select a point or line to see its source attributes. Use the map layer chips to isolate categories.</p></div><div className="explore-stat-chips">{["Hospitals","Schools","Parks","Water bodies","Flood risk"].map((c,i)=><button key={c} style={{"--layer-dot": ["#c66a5b","#7287a0","#778c69","#648fa0","#c66a5b"][i]} as React.CSSProperties} onClick={()=>mapLayers(c as Category)}><i/>{c}</button>)}</div></div>
          <section className="source-snapshots"><div className="source-snapshots-heading"><div><span className="eyebrow">SATELLITE &amp; LAND-COVER EVIDENCE</span><h2>Single-scene source notes</h2></div><span className="source-summary-note">Source summaries are not independent validation.</span></div><div className="source-snapshot-grid">{environmentalSnapshots.map(snapshot=><article className="source-snapshot" key={snapshot.label}><div className="source-snapshot-top"><span className="eyebrow">{snapshot.category??"SUMMARY ONLY"}</span><span className={`source-snapshot-tag ${snapshot.sourceOnly?"is-summary-only":""}`}>{snapshot.sourceOnly?"SUMMARY ONLY":"SPATIAL RECORDS"}</span></div><h3>{snapshot.label}</h3><p className="source-snapshot-finding">{snapshot.finding||snapshot.date}</p><div className="source-snapshot-detail"><span>{snapshot.date}</span><strong>{snapshot.sourceOnly?(snapshot.label==="Land-cover summary"?`${formatNumber(snapshot.sourceRows)} source classes · no mapped layer`:"Summary only · no mapped heat layer"):snapshot.count?`${formatNumber(snapshot.count)} active feature records`:"No active spatial records"}</strong></div><small>{snapshot.source} · {snapshot.scope}</small></article>)}</div><p className="source-snapshot-limit">Scene dates and indices come from the supplied processed summaries; observation conditions and source metric units may vary. Map features show their preserved record attributes. Cloud-cover figures are withheld where source conventions are ambiguous.</p></section>
        </>}

        {page==="Analyze"&&<>
          <SectionTitle label="ANALYZE · EVIDENCE FIRST" title="Let the counts breathe." copy="Choose a question, see the source behind it and read the limits before drawing a conclusion." action={<div className="analysis-picker"><select value={analysisType} onChange={e=>setAnalysisType(e.target.value)}><option value="regional">Regional record comparison</option><option value="quality">Data quality &amp; coordinate coverage</option><option value="proximity">Facility clustering · Haversine</option></select><button className="primary-btn" disabled={analysisBusy} onClick={()=>void runAnalysis()}>{analysisBusy?<span className="spin"><Activity size={14}/></span>:<Activity size={14}/>}Run analysis</button></div>} />
          {analysisError&&<div className="notice-bar notice-error">{analysisError}</div>}
          {!analysis&&<div className="analysis-loading"><span className="spin"><Activity/></span>Reading active feature records…</div>}
          {analysis&&analysisType==="regional"&&<>
            <div className="analysis-summary-card"><div><span className="eyebrow">WHAT THIS TABLE MEANS</span><h3>{text(analysis.question,"Regional source-count comparison")}</h3><p>{text(analysis.method)}</p></div><span className="analysis-dataset-tag"><Database size={13}/>{formatNumber(summary.quality.total)} active feature rows</span></div>
            <div className="chart-table-grid"><article className="chart-card"><div className="card-heading compact"><div><span className="eyebrow">REGIONAL SIGNALS</span><h3>Mapped facility records</h3></div><span className="chart-unit">RECORDS</span></div><div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><BarChart data={regionalData} margin={{top:6,right:6,left:-15,bottom:0}} barGap={4}><CartesianGrid stroke="#e7e1d5" strokeDasharray="3 5" vertical={false}/><XAxis dataKey="region" axisLine={false} tickLine={false} tick={{fontSize:11,fill:"#77766e"}}/><YAxis axisLine={false} tickLine={false} tick={{fontSize:10,fill:"#929088"}}/><Tooltip cursor={{fill:"#f4f1ea"}} contentStyle={{border:"1px solid #ded8cc",borderRadius:8,fontSize:12,boxShadow:"none"}}/><Bar dataKey="hospitals" name="Hospitals" fill="#c66a5b" radius={[3,3,0,0]}/><Bar dataKey="schools" name="Schools" fill="#7189a1" radius={[3,3,0,0]}/><Bar dataKey="parks" name="Parks" fill="#849374" radius={[3,3,0,0]}/></BarChart></ResponsiveContainer></div><div className="legend-row"><span><i style={{background:"#c66a5b"}}/>Hospitals</span><span><i style={{background:"#7189a1"}}/>Schools</span><span><i style={{background:"#849374"}}/>Parks</span><span className="legend-faint">Source-labeled regions only</span></div></article>
              <article className="table-card comparison-card"><div className="table-card-header"><div><span className="eyebrow">SOURCE-LABELED COUNTS</span><h3>Region comparison</h3></div></div><div className="comparison-list">{regions.map(item=>{const data=summary.regionalCounts[item]??{};return <div className={`comparison-row ${region===item?"comparison-current":""}`} key={item}><span className="comparison-label">{item}</span><div className="comparison-lines">{["Hospitals","Schools","Parks"].map((c,i)=>{const max=Math.max(...regions.map(r=>summary.regionalCounts[r]?.[c]??0),1);const value=data[c]??0;return <div className="comparison-mini-row" key={c}><span>{c}</span><i><b style={{width:`${Math.max(value?5:0,pct(value,max))}%`,background:["#c66a5b","#7189a1","#849374"][i]}}/></i><strong>{formatNumber(value)}</strong></div>;})}</div><button onClick={()=>setRegion(item)} className="comparison-focus" aria-label={`Focus ${item}`}>{region===item?<CheckCircle2 size={15}/>:<ChevronRight size={15}/>}</button></div>})}</div><p className="table-footnote">*These five regions describe the source project’s analytical split; they are not official wards.</p></article></div>
            <Caveat text={text(analysis.limitation)} /><div className="analysis-shortcuts"><button onClick={()=>mapLayers("Hospitals")}><MapIcon size={15}/>View facility records on the map</button><button onClick={()=>navigate("Data Management")}><Database size={15}/>Check dataset completeness</button></div>
          </>}
          {analysis&&analysisType==="quality"&&<>
            <div className="analysis-summary-card"><div><span className="eyebrow">DATA QUALITY / COVERAGE</span><h3>{text(analysis.question,"Coordinate and source-record review")}</h3><p>{text(analysis.method)}</p></div></div><div className="quality-table-wrap"><table className="quality-table"><thead><tr><th>DATASET</th><th>CATEGORY</th><th>SOURCE ROWS</th><th>MAPPABLE</th><th>NO VALID COORDINATE</th><th>COVERAGE</th></tr></thead><tbody>{(Array.isArray(analysis.datasets)?analysis.datasets:[]).map((d: any)=><tr key={d.name}><td><strong>{d.name}</strong></td><td>{d.category}</td><td>{formatNumber(d.sourceRecords)}</td><td>{formatNumber(d.mappedRecords)}</td><td>{formatNumber(d.invalidCoordinates)}</td><td><span className={`quality-pill ${(d.coordinateShare??0)<.75?"quality-review":""}`}>{d.coordinateShare===null?"No coordinates":`${Math.round(d.coordinateShare*100)}%`}</span></td></tr>)}</tbody></table></div><Caveat text={text(analysis.limitation)}/>
          </>}
          {analysis&&analysisType==="proximity"&&<>
            <div className="analysis-summary-card"><div><span className="eyebrow">GREAT-CIRCLE PROXIMITY · NOT ROUTE ACCESS</span><h3>{text(analysis.question)}</h3><p>{text(analysis.method)}</p></div></div><div className="proximity-grid">{Object.values((analysis.facilities??{}) as Record<string,any>).map((item:any)=><article className="proximity-card" key={item.category}><span className="eyebrow">{item.category.toUpperCase()}</span><strong>{item.nearestKmMean===null?"—":`${Number(item.nearestKmMean).toFixed(2)} km`}</strong><span>mean nearest-neighbour distance</span><p>{formatNumber(item.count)} source points · {formatNumber(item.sample)} measured</p></article>)}</div><Caveat text={text(analysis.limitation)}/>
          </>}
        </>}

        {page==="Intelligence"&&<>
          <SectionTitle label="INTELLIGENCE · EXPLAINABLE BASELINE" title="Signals to check, not verdicts." copy="A transparent comparison of where the records look lighter. Validate source completeness, capacity and population before acting." action={<span className="baseline-badge"><i/>RULE-BASED BASELINE</span>} />
          <div className="intelligence-banner"><span className="intelligence-mark"><Sparkles size={18}/></span><div><strong>Count difference ≠ service gap.</strong><p>The scores rank only relative observed feature counts among labeled project regions. They are not an ML prediction, accessibility measure, investment recommendation or needs assessment.</p></div><span className="eyebrow">NO VALIDATED MODEL</span></div>
          <div className="signal-list">{regions.map((item,index)=>{const row=summary.regionalCounts[item]??{};const categories=["Hospitals","Schools","Parks","Water bodies"];const maxTotals=categories.reduce((s,c)=>s+Math.max(...regions.map(r=>summary.regionalCounts[r]?.[c]??0),0),0)||1;const score=Math.round(100*categories.reduce((s,c)=>s+(1-(row[c]??0)/(Math.max(...regions.map(r=>summary.regionalCounts[r]?.[c]??0),1))),0)/categories.length);const label=score>=68?"REVIEW SOURCE COVERAGE":score>=40?"CHECK REPRESENTATION":"COUNTS MORE PRESENT";return <article className="signal-row" key={item}><span className="signal-ordinal">0{index+1}</span><div className="signal-region"><strong>{item}</strong><small>{Object.values(row).reduce((a,b)=>a+b,0).toLocaleString()} core feature rows</small></div><div className="signal-bars">{categories.map(c=>{const val=row[c]??0;const max=Math.max(...regions.map(r=>summary.regionalCounts[r]?.[c]??0),1);return <div key={c} className="signal-bar-segment"><span>{c}</span><i><b style={{width:`${pct(val,max)}%`}}/></i><strong>{formatNumber(val)}</strong></div>})}</div><div className={`signal-rank ${score>=68?"rank-review":""}`}><span>{label}</span><strong>{score}</strong><small>relative count index</small></div><div className="signal-next"><span className="eyebrow">SUGGESTED NEXT STEP</span><p>{score>=68?`Verify the ${item} records with a current authoritative facility inventory before inferring a coverage gap.`:`Confirm population and facility capacity in ${item} before comparing service access.`}</p><button onClick={()=>setRegion(item)}>Focus this region <ArrowRight size={13}/></button></div></article>})}</div>
          <Caveat text={`Baseline method: relative inverse feature-count index for hospitals, schools, parks and water bodies (equal weights; each category scaled against the maximum observed in the five labeled regions). No population, facility capacity, source-completeness denominator, travel network, official wards or validated prediction model. ${String((analysis as any)?.limitation??"")}`}/>
          <div className="intelligence-footer"><div><BookOpenText size={17}/><span>Need a stronger signal?<br/><strong>Bring a trusted denominator.</strong></span></div><button className="secondary-btn" onClick={()=>navigate("Data Management")}>Review dataset quality <ArrowRight size={14}/></button></div>
        </>}

        {page==="Report"&&<>
          <SectionTitle label="REPORT · EXPORTABLE EVIDENCE" title="A report you can audit." copy="Select a region and the active source layers to create a short, traceable evidence note." action={<div className="report-export-actions"><button className="secondary-btn" onClick={downloadCsv} disabled={!report?.records.length}><ArrowDownToLine size={15}/>Export CSV</button><button className="primary-btn" onClick={()=>void downloadPdf()} disabled={!report?.records.length}><FileText size={15}/>Export PDF</button></div>} />
          <div className="report-filters"><div className="report-region-picker"><span className="eyebrow">REPORT AREA</span><div><select value={region} onChange={e=>setRegion(e.target.value as Region)}><option>All regions</option>{regions.map(r=><option key={r}>{r}</option>)}</select><button className="secondary-btn" onClick={()=>void refreshReport()} disabled={reportBusy}>{reportBusy?<span className="spin"><Activity size={14}/></span>:<Activity size={14}/>}Refresh</button></div></div><div className="report-datasets-picker"><span className="eyebrow">SOURCE DATASETS · {reportDatasetKeys.length?`${reportDatasetKeys.length} selected`:"ALL ACTIVE"}</span><div className="report-category-select">{activeDatasets.map(dataset=><button type="button" key={dataset.key} className={!reportDatasetKeys.length||reportDatasetKeys.includes(dataset.key)?"selected":""} onClick={()=>toggleReportDataset(dataset.key)} title={dataset.source}><i>{!reportDatasetKeys.length||reportDatasetKeys.includes(dataset.key)?<CheckCircle2 size={12}/>:null}</i><span>{dataset.name}</span><small>{dataset.category}</small></button>)}</div></div><div className="report-indicator-picker"><span className="eyebrow">REPORT INDICATORS</span><div className="report-indicator-select">{reportIndicatorOptions.map(indicator=><button key={indicator.key} className={reportIndicators.includes(indicator.key)?"selected":""} onClick={()=>toggleReportIndicator(indicator.key)}><i>{reportIndicators.includes(indicator.key)?<CheckCircle2 size={12}/>:null}</i>{indicator.label}</button>)}</div><small>At least one indicator stays selected; coordinate coverage describes record mappability, not positional accuracy.</small></div></div>
          {reportError&&<div className="notice-bar notice-error">{reportError}</div>}
          <article className="report-document"><header className="report-document-head"><div><span className="eyebrow">GEOTWINAI / PHYSICAL DIGITAL TWIN</span><h2>Nagpur · Evidence note</h2><p>Observed source records in the current data workspace</p></div><div className="report-stamp"><span>PREPARED</span><strong>{report?formatDate(report.reportDate):"—"}</strong><small>{report?.region??region}</small></div></header>
            <div className="report-intro"><p>This note summarizes the selected, active database records for {report?.region??region}. It reports what is present in the workspace; it does not equate lower feature counts with unmet need.</p></div>
            {reportBusy&&!report?<div className="analysis-loading">Generating the record-backed report…</div>:report?.records.length?<div className="report-data-table"><div className="report-data-head" style={{gridTemplateColumns:`minmax(150px,1.45fr) minmax(85px,.85fr) repeat(${report.indicators.length},minmax(90px,1fr))`}}><span>DATASET / CATEGORY</span><span>REGION</span>{report.indicators.map(key=><span key={key}>{reportIndicatorOptions.find(item=>item.key===key)?.label.toUpperCase()}</span>)}</div>{report.records.map((row,i)=><div className="report-data-row" style={{gridTemplateColumns:`minmax(150px,1.45fr) minmax(85px,.85fr) repeat(${report.indicators.length},minmax(90px,1fr))`}} key={`${row.dataset}-${row.category}-${row.region}-${i}`}><span><i className="report-row-dot" style={{background:["#527c8c","#c66a5b","#849374","#7189a1"][i%4]}}/><span className="report-dataset-cell"><strong>{row.category}</strong><small>{row.dataset}</small></span></span><span>{row.region}</span>{report.indicators.map(key=><strong key={key}>{key==="source"?formatNumber(row.records):key==="mapped"?formatNumber(row.mapped):row.coveragePercent===null?"—":`${row.coveragePercent.toFixed(1)}%`}</strong>)}</div>)}</div>:<div className="table-empty"><Database size={22}/><p>No active records match this selection yet. Add data in Data Management to build the report.</p></div>}
            <div className="report-method-grid"><div><span className="eyebrow">METHOD</span><p>{report?.methodology??"Counts from active database records, grouped by source region."}</p></div><div><span className="eyebrow">LIMITATIONS</span><p>{report?.limitations??"Source completeness, positional accuracy and official boundaries are not independently verified."}</p></div></div>
            <footer className="report-foot"><span>Source files: {report?.sourceFiles.length?Array.from(new Set(report.sourceFiles)).join(", "):"active data registry"}</span><span>Region labels are analytical, not official wards.</span></footer>
          </article>
        </>}

        {page==="Data Management"&&<><SectionTitle label="DATA MANAGEMENT · PERSISTENT DATABASE" title="Keep the evidence intact." copy="Inspect source coverage, bring in new data with care and keep a clear record of what is active." action={<button className="text-link" onClick={()=>void refreshData()}>Refresh summary <RefreshCw size={14}/></button>} /><DataImportPanel region={region} canManage={canManage} onDataChanged={()=>void refreshData()}/></>}

        {page==="Settings"&&<>
          <SectionTitle label="SETTINGS · PROJECT CONTEXT" title="Know what is in the model." copy="A small, transparent settings panel for the data, map and analytical boundaries used in this workspace." />
          <article className="settings-account-panel"><div className="settings-account-copy"><span className="eyebrow">WORKSPACE ACCESS</span><h3>{canManage?"Project owner":"Signed-in collaborator"}</h3><p>Signed in as {accountName}{accountEmail?` · ${accountEmail}`:""}. Dataset changes are restricted to the configured project owner.</p>{ownerSetupRequired&&!canManage&&<div className="owner-setup-block"><span className="eyebrow">OWNER SETUP · PROTECTED PROJECT SETTINGS CARD</span><code>{accountOpenId||"Account identifier unavailable"}</code><p>{accessNote||"Copy your account ID here, then enter it only in the protected project settings card. Do not paste it into chat."}</p></div>}{!ownerSetupRequired&&!canManage&&<p className="read-only-callout">Read-only access. Ask the configured project owner to manage source files.</p>}</div><div className="settings-account-actions">{ownerSetupRequired&&!canManage&&<button className="secondary-btn" disabled={!accountOpenId} onClick={()=>void copyOwnerIdentity()}><Copy size={14}/>Copy account ID</button>}<button className="secondary-btn" onClick={()=>void onLogout()}><LogOut size={14}/>Sign out</button></div></article>
          <div className="settings-grid"><article className="settings-card"><span className="eyebrow">PROJECT STATUS</span><div className="settings-status"><i className={`status-dot ${databaseReady?"dot-live":"dot-error"}`}/><strong>{databaseReady?"Managed database connected":"Database connection unavailable"}</strong></div><dl><div><dt>ACTIVE DATASETS</dt><dd>{formatNumber(activeDatasets.length)}</dd></div><div><dt>ACTIVE FEATURE ROWS</dt><dd>{formatNumber(summary.quality.total)}</dd></div><div><dt>MAPPABLE RECORDS</dt><dd>{formatNumber(mapped)}</dd></div><div><dt>ANALYTICAL REGIONS</dt><dd>North · South · East · West · Central</dd></div></dl></article><article className="settings-card"><span className="eyebrow">MAP / GEOGRAPHY</span><h3>Source-backed coordinates</h3><p>The map draws supplied feature geometries on a local coordinate grid, not a live raster feed. OpenStreetMap-derived source records are credited on-map; feature popups show their file provenance.</p><dl><div><dt>STUDY CENTER</dt><dd>21.1458° N, 79.0882° E</dd></div><div><dt>MAP COORDINATES</dt><dd>WGS84 · EPSG:4326</dd></div><div><dt>REGION BOUNDARIES</dt><dd>Analytical project regions, not official wards</dd></div></dl></article><article className="settings-card"><span className="eyebrow">DATA CAVEATS</span><h3>Evidence, with context.</h3><ul className="caveat-list"><li>Counts describe active source records, not citywide completeness or population.</li><li>A valid numeric coordinate range is not proof of the original CRS or positional accuracy.</li><li>Satellite records are date/scene dependent; rainfall and cloud conditions matter.</li><li>Never interpret count-based region differences alone as underserved status.</li><li>Confirm every planning decision with current authoritative datasets and local knowledge.</li></ul></article><article className="settings-card"><span className="eyebrow">ASSISTANT / DECISION SUPPORT</span><h3>Transparent AI, if available.</h3><p>Geo queries current database aggregates first. When the managed AI service is available, it interprets only that verified context; otherwise the deterministic local data-query mode remains available.</p><p>No arbitrary model-generated SQL is run. “Review coverage” signals are a rule-based baseline, not a validated prediction or official recommendation.</p></article></div>
          <div className="settings-foot"><Database size={16}/><span>Configuration is managed server-side. Credentials are not exposed to the browser; no external government-data connectors are currently claimed.</span><button onClick={()=>navigate("Data Management")}>Open data management <ArrowRight size={14}/></button></div>
        </>}

        <footer className="workspace-footer"><span>GEOTWINAI&nbsp; · &nbsp;NAGPUR STUDY AREA</span><span>Evidence before inference <i/> {databaseReady?`${formatNumber(summary.quality.total)} active feature rows`:"Connecting to persistent records"}</span><span>OpenStreetMap-derived source records are credited on-map; the coordinate grid is local.</span></footer>
      </div></div>
    </section>
    <GeoAssistant onAction={assistantAction} activeRegion={region}/>
  </main>;
}

function Metric({ icon, label, value, sub, loading }: { icon: React.ReactNode; label: string; value: number; sub: string; loading: boolean }) {
  return <div className="metric-card"><span className="metric-glyph">{icon}</span><div className="metric-text"><span>{label}</span><strong>{loading&&value===0?<i className="metric-placeholder"/>:formatNumber(value)}</strong><small>{sub}</small></div><span className="metric-mark">{label.includes("BUILDING")?"01":label.includes("ROAD")?"02":label.includes("FACILITIES")?"03":"04"}</span></div>;
}
function Caveat({ text }: { text: string }) { return <div className="caveat-panel"><ShieldAlert size={17}/><div><strong>INTERPRET WITH CARE</strong><p>{text}</p></div><span className="eyebrow">METHOD NOTE</span></div>; }
