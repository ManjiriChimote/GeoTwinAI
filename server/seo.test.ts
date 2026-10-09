import { describe, expect, it } from "vitest";
import {
  configuredPublicOrigin,
  injectPublicSeoHead,
  publicNotFoundHtml,
  robotsTxt,
  sitemapXml,
} from "./seo";

const landing = '<meta name="robots" content="noindex,nofollow" />\n<!-- GEO_TWIN_PUBLIC_SEO_HEAD -->';

describe("GeoTwinAI public SEO boundary", () => {
  it("does not invent a canonical URL before a real public origin is configured", () => {
    expect(configuredPublicOrigin(undefined)).toBeNull();
    expect(configuredPublicOrigin("not-a-url")).toBeNull();
    expect(configuredPublicOrigin("http://geotwin.example")).toBeNull();
    expect(configuredPublicOrigin("https://preview.manus.computer")).toBeNull();
    const rendered = injectPublicSeoHead(landing, null);
    expect(rendered).toContain('content="noindex,nofollow"');
    expect(rendered).not.toContain("rel=\"canonical\"");
    expect(rendered).not.toContain("GEO_TWIN_PUBLIC_SEO_HEAD");
  });

  it("emits canonical and social metadata only for a valid HTTPS origin", () => {
    const origin = configuredPublicOrigin("https://www.example.com/");
    expect(origin).toBe("https://www.example.com");
    const rendered = injectPublicSeoHead(landing, origin);
    expect(rendered).toContain('content="index,follow,max-image-preview:large"');
    expect(rendered).toContain('rel="canonical" href="https://www.example.com/"');
    expect(rendered).toContain('property="og:image" content="https://www.example.com/geotwin-og.png"');
    expect(rendered).toContain('type="application/ld+json"');
  });

  it("provides a crawl-excluded 404 page with a real public recovery link", () => {
    const page = publicNotFoundHtml();
    expect(page).toContain('name="robots" content="noindex,nofollow"');
    expect(page).toContain("This page isn't in the model.");
    expect(page).toContain('href="/"');
  });

  it("blocks preview indexing and exposes only the public page in its canonical sitemap", () => {
    expect(robotsTxt(null)).toBe("User-agent: *\nDisallow: /\n");
    const rules = robotsTxt("https://www.example.com");
    expect(rules).toContain("Allow: /");
    expect(rules).not.toContain("Disallow: /workspace");
    expect(rules).toContain("Disallow: /api/");
    expect(rules).toContain("Sitemap: https://www.example.com/sitemap.xml");
    const sitemap = sitemapXml("https://www.example.com");
    expect(sitemap).toContain("https://www.example.com/");
    expect(sitemap).not.toContain("/workspace");
  });
});
