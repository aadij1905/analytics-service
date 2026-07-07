const path = require("path");
const { crawlPage } = require("./crawl");

const TOP_N = 8;
const SCREENSHOTS_DIR = path.join(__dirname, "../screenshots");

async function runCrawler(normalized, websiteUrl, outputDir = SCREENSHOTS_DIR) {
  const topPages = [...normalized.pages]
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, TOP_N);

  const crawledPages = [...normalized.pages];

  for (const target of topPages) {
    const url = `${websiteUrl.replace(/\/$/, "")}${target.path}`;
    try {
      const crawlResult = await crawlPage(url, outputDir);
      const idx = crawledPages.findIndex((p) => p.path === target.path);
      if (idx !== -1) {
        crawledPages[idx] = {
          ...crawledPages[idx],
          ...crawlResult,
          crawlerEnriched: true,
        };
      }
    } catch (err) {
      console.error(`Crawler failed for ${url}:`, err.message);
      // ShopifyQL fields stay intact — only crawler-exclusive fields remain null
    }
  }

  return { ...normalized, pages: crawledPages };
}

module.exports = { runCrawler };
