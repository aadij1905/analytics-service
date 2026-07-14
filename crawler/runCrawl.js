const path = require("path");
const { openSession } = require("./crawl");

// Crawl time scales roughly linearly per page (shared Playwright session in
// crawl.js reuses one browser via openSession() — see crawl.js:28 — so this
// is more iterations, not more browser launches). 50 is high enough to cover
// effectively every page ShopifyQL reports traffic for, while still capping
// worst-case crawl time for stores with hundreds of landing pages.
const TOP_N = 50;
const SCREENSHOTS_DIR = path.join(__dirname, "../screenshots");

// Shopify themes are template-based (Dawn's product template renders every
// product page). Crawling the 5 top product pages gives one useful signal
// repeated 5 times. Better to sample one representative per template AND
// spend the remaining budget on highest-traffic outliers.
function templateOf(pagePath) {
  if (!pagePath) return "other";
  const p = pagePath.toLowerCase();
  if (p === "/" || p === "") return "home";
  if (p.startsWith("/products/")) return "product";
  if (p.startsWith("/collections/")) return "collection";
  if (p === "/cart") return "cart";
  if (p.startsWith("/pages/")) return "page";
  if (p.startsWith("/blogs/")) return "blog";
  return "other";
}

function pickPages(pages, limit = TOP_N) {
  const sorted = [...pages].sort((a, b) => b.sessions - a.sessions);
  const chosen = [];
  const seenPaths = new Set();
  const seenTemplates = new Set();

  // Pass 1: highest-traffic page per template (guarantees coverage).
  for (const p of sorted) {
    if (chosen.length >= limit) break;
    const tpl = templateOf(p.path);
    if (seenTemplates.has(tpl)) continue;
    seenTemplates.add(tpl);
    seenPaths.add(p.path);
    chosen.push(p);
  }

  // Pass 2: fill remaining budget with highest-traffic outliers we haven't
  // taken yet — catches unusually-important product/collection pages.
  for (const p of sorted) {
    if (chosen.length >= limit) break;
    if (seenPaths.has(p.path)) continue;
    seenPaths.add(p.path);
    chosen.push(p);
  }

  return chosen;
}

async function runCrawler(normalized, websiteUrl, storePassword = null, outputDir = SCREENSHOTS_DIR) {
  const targets = pickPages(normalized.pages, TOP_N);
  const crawledPages = [...normalized.pages];
  const trimmedUrl = websiteUrl.trim().replace(/\/$/, "");
  // Store settings can be saved as a bare domain (no scheme) — Playwright's
  // page.goto rejects that outright rather than assuming https.
  const base = /^https?:\/\//i.test(trimmedUrl) ? trimmedUrl : `https://${trimmedUrl}`;

  const session = await openSession();
  try {
    // Unlock once per session — the cookie it sets persists across every
    // visit() below. unlockResult is null if the store isn't
    // password-protected (proceed normally), false if a wall was found but
    // unlock genuinely failed (skip — every page would just hit the same
    // wall, wasting crawl time and repeated password attempts against the
    // store), true on success.
    const unlockResult = storePassword ? await session.unlock(base, storePassword) : null;

    if (unlockResult === false) {
      console.error(`Storefront unlock failed for ${base} — skipping crawl (would only hit the password wall).`);
    } else {
      for (const target of targets) {
        const url = `${base}${target.path}`;
        try {
          const crawlResult = await session.visit(url, outputDir);
          const idx = crawledPages.findIndex((p) => p.path === target.path);
          if (idx !== -1) {
            crawledPages[idx] = {
              ...crawledPages[idx],
              ...crawlResult,
              // A page blocked by the password wall (cookie didn't apply,
              // expired mid-crawl, etc.) is not real data — never mark it
              // enriched, so downstream consumers (flags, future vision
              // analysis) don't treat a wall screenshot as the real page.
              crawlerEnriched: !crawlResult.crawlerBlocked,
              template: templateOf(target.path),
            };
          }
        } catch (err) {
          console.error(`Crawler failed for ${url}:`, err.message);
          // ShopifyQL fields stay intact — only crawler-exclusive fields remain null
        }
      }
    }
  } finally {
    await session.close();
  }

  return { ...normalized, pages: crawledPages };
}

module.exports = { runCrawler, pickPages, templateOf };
