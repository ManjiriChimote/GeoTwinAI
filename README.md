# GeoTwinAI — The Living Digital Twin of Nagpur

A source-aware GIS and urban decision-support workspace for the supplied Nagpur study-area data. It is built on the managed Webdev server and MySQL database, React, Leaflet, Express and Drizzle, and requires first-party Manus sign-in. Its interactive maps use an OpenStreetMap basemap beneath source-backed GeoTwinAI feature layers. It does **not** represent a live or authoritative model of every part of the city.

## Run the application

Requirements: Node.js 22, pnpm 10.18, access to a MySQL database via `DATABASE_URL`, and valid Manus OAuth configuration. Manus Preview supplies its managed database, server runtime and session identity. Interactive maps request only the visible OpenStreetMap tiles and show provider attribution.

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev
```

The server listens on `PORT` (3000 by default). The first server start streams the bundled, clean source records into the configured database using an idempotent database lock. On subsequent starts, completed source datasets are left intact. To run schema-generation work after an intentional schema edit, review the generated migration before committing it and use `pnpm db:push` only in the project's configured database environment.

Useful commands:

- `pnpm dev` — Vite/Express development server.
- `pnpm check` — TypeScript check.
- `pnpm test` — Vitest suite.
- `pnpm build` — frontend and server production build.
- `pnpm start` — built server.
- `pnpm db:migrate` — apply checked-in Drizzle migrations.

Private runtime values (`DATABASE_URL`, optional built-in service credentials and upload configuration) stay server-side. Never place provider credentials in client code. `client/public/manus-routes.json` is the current public page-route manifest; refresh it when page routes change.

## Project structure

- `client/public/landing.html`, `landing.css`, `geotwin-og.png` — source-grounded public landing page and social preview card.
- `client/src/pages/Home.tsx` — primary responsive workspace and section routing.
- `client/src/components/GeoTwinMap.tsx` — OpenStreetMap-backed Leaflet renderer, bounded source-record queries and feature inspection.
- `client/src/components/GeoTwinAuthGate.tsx` — branded Manus sign-in boundary and private-route gate.
- `client/src/components/DataImportPanel.tsx` — preview, explicit import, registry and history.
- `client/src/components/GeoAssistant.tsx` — grounded assistant interface and persisted conversations.
- `client/src/lib/geotwin-api.ts` — typed HTTP contracts.
- `client/src/index.css` — editorial cartography visual system, map and responsive UI.
- `server/geotwin/routes.ts` — map, imports, analytics, reports and conversation API.
- `server/geotwin/database.ts` — MySQL pool and restart-safe streamed bootstrap.
- `server/geotwin/shared.ts` — coordinate and feature normalization.
- `server/seo.ts` — canonical/Open Graph metadata, crawler rules, public sitemap and workspace noindex policy.
- `server/data/seed/` — bundled compressed project-source records and provenance manifests.
- `drizzle/` — additive MySQL migrations and schema definitions.

## Bundled source data

The supplied project archive contributes **310,008** rows from 10 processed spatial datasets:

| Dataset | Source rows |
|---|---:|
| Buildings | 46,052 |
| Roads | 110,566 |
| Hospitals | 412 |
| Schools | 75 |
| Parks | 142 |
| Water bodies | 29 |
| Built-up spatial sample | 16,949 |
| Flood-risk spatial sample | 53,097 |
| Green-cover spatial sample | 61,640 |
| Sentinel-2 NDVI spatial sample | 21,046 |

Rows and coordinate counts are imported and queried from the database, not hard-coded into page counters. The importer uses the supplied cleaned versions rather than duplicate raw/`_1` files; it retains non-empty source properties. `server/data/seed/provenance.json` records source filenames, source and mapped counts, and a digest. The companion summary manifest is retained in the managed metric table. No untrusted pickle is executed.

Project references (including the master build prompt, analysis outputs, screenshots, charts, example interactive map and the professional report) are preserved in the original supplied archive for inspection; those artifacts are not all exposed as unsupported public claims. The report's described regions are treated as **five analytical project regions, not official wards**.

## Imports and persistence

The Data Management page accepts CSV, GeoJSON Feature, and GeoJSON FeatureCollection files up to 50 MB, previews fields and sample rows, asks for CRS confirmation when the source cannot verify WGS84, retains source properties, reports invalid/missing coordinates and deduplicates. GeoPackage is **not accepted directly**; export it to GeoJSON first. Uploaded datasets, features, status, provenance metadata and import events persist in MySQL. Database volume is shared by the configured development and production runtime: deliberate deletions change persisted records. Deleting an uploaded dataset requires explicit confirmation; bundled source datasets cannot be deleted through that control.

The private map overlays source-supplied GIS geometries on an interactive OpenStreetMap basemap; the public landing page uses an interactive Nagpur map with no private dataset overlays. Both maps visibly attribute OpenStreetMap contributors. The app loads the visible map view only; it does not offer bulk tile downloads. Spatial feature responses are capped per selected category to keep the browser responsive; zoom/pan to refine the viewport. The app does not claim an authoritative ward boundary, verified positional accuracy, time-series changes, live sensors or complete municipal coverage.

## Analyses and AI

Counts and data-quality summaries are deterministic queries over active, successfully imported database records. The clustering comparison uses a documented great-circle (Haversine) nearest-feature method, not travel-network accessibility. “Review source coverage” is a deliberately limited rule-based index using relative feature counts; it is **not** a trained/validated model, need estimate or service-access measurement. Never interpret a smaller count alone as unmet need.

The Geo assistant queries vetted database aggregates and uses only this context for any optional configured managed text-generation step. SQL is parameterized and no model-generated SQL is executed. Without the managed text service, the deterministic, data-grounded answer path remains available.


## Windows and VS Code setup

1. Install Node.js 22 LTS. In a new PowerShell terminal, run `corepack enable`, then clone or open this repository in VS Code and open its project directory.
2. Copy `.env.example` to `.env`; supply `DATABASE_URL` for a MySQL-compatible database. The GeoTwinAI workspace uses its own email/password accounts and does not require Manus OAuth to sign in. Keep `.env` private. Managed AI is optional; deterministic local answers remain available without an external text-generation service. Never add private values to browser code or Git.
3. Run `pnpm install --frozen-lockfile`, `pnpm db:migrate`, and `pnpm dev`. The public overview is at `http://localhost:3000`; open `/workspace` to create an account or sign in. Account records, scrypt password hashes, terms acceptance and revocable sessions persist in MySQL; session tokens are stored only as hashes, and mutating requests require a CSRF token. `pnpm check` and `pnpm build` are the source and production-build checks. A local database is separate from Manus's managed database; schema/data writes affect only the `DATABASE_URL` configured for that process.
4. New registrations are read-only; the first person to sign up never becomes the owner automatically. To enable dataset writes, the project owner must configure both `GEOTWIN_OWNER_EMAIL` and `GEOTWIN_OWNER_ACCOUNT_ID` through protected project settings for the same account. After registering, the intended owner can copy their numeric account ID from Settings; do not send it in chat. Until both values match, all shared-data write actions remain locked. Email verification and password-reset email are not configured. Data bootstrap is restart-safe: after the schema exists, the server streams the supplied compressed source rows into the database once. Do not point a local app at a valuable database without understanding that the tables are shared and persistent.

## Manus-managed preview and deployment

The application uses the selected Manus-managed server/container and its persistent MySQL database. Use the Manus project Preview to review changes. Checkpoint the source on the connected canonical project repository, then use the project's Dashboard publication controls if publication is explicitly wanted. Development and published runtimes share the project database; importing, toggling or deleting data in either environment changes the same records. The MySQL provider is intentionally retained instead of adding an unavailable PostGIS server; viewport filters use indexed, parameterized latitude/longitude and category queries.

Every protected `/api/geotwin/*` data request requires an active email/password account session. Dataset upload, activation and deletion require the same account to match both `GEOTWIN_OWNER_EMAIL` and `GEOTWIN_OWNER_ACCOUNT_ID` from protected settings; a typed email or a self-registered account alone never grants administrator access. The owner ID stays out of source control. Conversations use an account-derived hash to keep one collaborator from loading another collaborator's history. Account creation is immediate; email verification and self-service password reset are not configured. Keep the site at owner/team access scope. Public exposure of analytical data is not recommended without the project's explicit permission review.

## Map provider decision (2026-10-10)

The overview and private workspace use Leaflet with the standard HTTPS OpenStreetMap raster map; tiles are fetched for the current interactive view, not prefetched. Visible map attribution links directly to the OpenStreetMap copyright page. The public landing view contains only the public basemap and no private GeoTwinAI data. Provider terms: [OpenStreetMap Standard tile policy](https://operations.osmfoundation.org/policies/tiles/). The project’s Managed Maps proxy rejected the current Preview origin, so the Google maps proxy is not used here.

## Source review note

The professional report says zero water-body features, but processed `Nagpur_WaterBodies_Clean.csv` contains 29 records. The project seeds the cleaned CSV and explicitly discloses the discrepancy so reviewers can reconcile it before authoritative use. The project bundle includes 310,008 records across ten clean spatial source tables. Satellite summaries retain their supplied dates/scope and are not promoted to mapped records unless an actual spatial dataset exists.

## SEO readiness and search indexing

The initial HTML at `/` is a public, source-grounded GeoTwinAI overview; the private interactive workspace lives at `/workspace`. The workspace returns `noindex,nofollow`. The server has a root-only sitemap for a configured real public origin. Preview is noncanonical: its SEO gateway disallows crawling and currently withholds `/sitemap.xml` with a gateway placeholder response. Never interpret that Preview response as the final published sitemap.

`GEOTWIN_PUBLIC_ORIGIN` is intentionally blank until the user selects and controls a real HTTPS domain. When set, the server emits the canonical/Open Graph/social-card URLs, WebSite structured data, a root-only sitemap, and crawl rules that exclude APIs. Canonical robots do not block `/workspace`, so crawlers can see its noindex header; authentication still guards every data API. The Webdev SEO gateway owns `/robots.txt` and `/sitemap.xml`; after a domain is attached and the site is published, verify the actual `x-manus-seo-source` and served documents before submitting them. No public release or DNS change is made by preparing these files.

After a public launch, verify the domain in [Google Search Console](https://search.google.com/search-console/about), submit `https://<your-domain>/sitemap.xml`, and optionally request recrawling of the landing page. [Google's sitemap guide](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap) calls sitemap submission a hint, not a guarantee; [Google's recrawl guide](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl) says crawling may take days to weeks and inclusion is not guaranteed. Brave's official [Submit URL](https://search.brave.com/submit-url) page lets an owner request that a URL be re-fetched. Neither engine promises indexing, a date or ranking. SEO can make the page eligible and discoverable; it cannot guarantee that typing “GeoTwinAI” returns it immediately, particularly for a new or unlinked domain.
