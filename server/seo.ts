import type { Express, RequestHandler } from "express";
import fs from "node:fs/promises";
import path from "node:path";

export const PUBLIC_PAGE_TITLE = "GeoTwinAI — Nagpur Urban GIS Digital Twin";
export const PUBLIC_PAGE_DESCRIPTION = "Explore a source-grounded Nagpur GIS workspace for mapped urban features, project-defined regions and transparent planning analysis.";

export function configuredPublicOrigin(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.hostname.endsWith(".manus.computer") ||
      url.hostname.endsWith(".manuspre.computer")
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function escapeAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function injectPublicSeoHead(template: string, origin: string | null) {
  if (!origin) return template.replace("<!-- GEO_TWIN_PUBLIC_SEO_HEAD -->", "");
  const url = escapeAttribute(`${origin}/`);
  const image = escapeAttribute(`${origin}/geotwin-og.png`);
  const tags = [
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:type" content="image/png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:image" content="${image}" />`,
    `<meta name="twitter:image:alt" content="GeoTwinAI cartographic study sketch; illustrative, not a geographic map" />`,
  ].join("\n    ");
  const webSiteSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "GeoTwinAI",
    url,
    description: PUBLIC_PAGE_DESCRIPTION,
    inLanguage: "en-IN",
  }).replaceAll("<", "\\u003c");
  const structuredData = `<script type="application/ld+json">${webSiteSchema}</script>`;
  return template
    .replace('name="robots" content="noindex,nofollow"', 'name="robots" content="index,follow,max-image-preview:large"')
    .replace("<!-- GEO_TWIN_PUBLIC_SEO_HEAD -->", `${tags}\n    ${structuredData}`);
}

export function robotsTxt(origin: string | null) {
  if (!origin) return "User-agent: *\nDisallow: /\n";
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /manus-oauth/",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}

export function sitemapXml(origin: string) {
  const escapedOrigin = origin.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${escapedOrigin}/</loc></url></urlset>`;
}

export function publicNotFoundHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="robots" content="noindex,nofollow"/><title>Page not found — GeoTwinAI</title><link rel="stylesheet" href="/landing.css"/></head><body><main class="not-found" style="max-width:760px;margin:12vh auto;padding:32px"><p class="eyebrow">404 · GEO TWIN</p><h1>This page isn't in the model.</h1><p>The public overview is available at GeoTwinAI's home page. Private workspace access is available from there after sign-in.</p><a class="button-primary" href="/">Return to the public overview</a></main></body></html>`;
}

export function registerPublicSeoRoutes(app: Express) {
  const publicDir = path.resolve(
    process.cwd(),
    process.env.NODE_ENV === "production" ? "dist/public" : "client/public",
  );
  const origin = configuredPublicOrigin(process.env.GEOTWIN_PUBLIC_ORIGIN);

  app.get("/", async (_req, res, next) => {
    try {
      const template = await fs.readFile(path.join(publicDir, "landing.html"), "utf-8");
      const body = injectPublicSeoHead(template, origin);
      res.set("Cache-Control", "public, max-age=300").type("html").send(body);
    } catch (error) {
      next(error);
    }
  });

  app.get("/robots.txt", (_req, res) => {
    res.set("Cache-Control", "no-store").type("text/plain").send(robotsTxt(origin));
  });

  app.get("/sitemap.xml", (_req, res) => {
    if (!origin) {
      res.status(503).set("Cache-Control", "no-store").type("text/plain").send("Sitemap is withheld until a public HTTPS domain is configured.");
      return;
    }
    res.set("Cache-Control", "public, max-age=3600").type("application/xml").send(sitemapXml(origin));
  });

  const workspaceNoIndex: RequestHandler = (_req, res, next) => {
    res.set("X-Robots-Tag", "noindex, nofollow");
    next();
  };
  app.use("/workspace", workspaceNoIndex);

  app.get("/workspace/", (req, res, next) => req.path === "/workspace/" ? res.redirect(308, "/workspace") : next());
  app.get("/index.html", (_req, res) => res.redirect(308, "/"));
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    const requestPath = req.path;
    if (requestPath === "/" || requestPath === "/workspace") return next();
    if (requestPath.startsWith("/api") || requestPath.startsWith("/manus-oauth/") || requestPath.startsWith("/manus-storage/") || requestPath.startsWith("/__") || requestPath.startsWith("/@") || requestPath.startsWith("/assets/") || requestPath.startsWith("/src/") || requestPath.startsWith("/node_modules/")) return next();
    if (requestPath === "/landing.html" || (path.extname(requestPath) && !requestPath.endsWith(".html"))) return next();
    return res.status(404).set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }).type("html").send(publicNotFoundHtml());
  });
}
