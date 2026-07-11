const path = require("path");
const { openSession } = require("./crawl");

const TOP_N = 8;
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

async function runCrawler(normalized, websiteUrl, outputDir = SCREENSHOTS_DIR) {
  const targets = pickPages(normalized.pages, TOP_N);
  const crawledPages = [...normalized.pages];
  const base = websiteUrl.replace(/\/$/, "");

  const session = await openSession();
  try {
    for (const target of targets) {
      const url = `${base}${target.path}`;
      try {
        const crawlResult = await session.visit(url, outputDir);
        const idx = crawledPages.findIndex((p) => p.path === target.path);
        if (idx !== -1) {
          crawledPages[idx] = {
            ...crawledPages[idx],
            ...crawlResult,
            crawlerEnriched: true,
            template: templateOf(target.path),
          };
        }
      } catch (err) {
        console.error(`Crawler failed for ${url}:`, err.message);
        // ShopifyQL fields stay intact — only crawler-exclusive fields remain null
      }
    }
  } finally {
    await session.close();
  }

  return { ...normalized, pages: crawledPages };
}

module.exports = { runCrawler, pickPages, templateOf };
