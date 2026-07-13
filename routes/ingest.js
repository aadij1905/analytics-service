const express = require("express");
const router = express.Router();
const { normalize } = require("../normalize/normalize");
const { detectAll } = require("../detectors/detectors");
const { setData, setCrawlStatus } = require("../data/cache");
const { runCrawler } = require("../crawler/runCrawl");

router.post("/api/analytics/ingest", async (req, res) => {
  const rawExtraction = req.body;
  if (!rawExtraction || !rawExtraction.storeId || !rawExtraction.raw) {
    return res.status(400).json({
      error: "storeId and raw extraction data are both required",
    });
  }

  const { storeId, websiteUrl, storePassword } = rawExtraction;
  const shouldCrawl = Boolean(websiteUrl && websiteUrl.trim().length > 0);

  const normalized = normalize(rawExtraction);
  const flags = detectAll(normalized, { crawlerRan: false });
  setData(storeId, normalized, flags, rawExtraction, { crawlerRan: false });

  // Respond immediately — ShopifyQL data is live, don't block on crawl
  res.json({
    success: true,
    storeId,
    dataSource: "shopify",
    ingestedAt: new Date().toISOString(),
    flagsDetected: flags.length,
    crawlerTriggered: shouldCrawl,
    message: `Real analytics data ingested. ${flags.length} flags detected.${
      shouldCrawl ? " Crawler running asynchronously." : ""
    }`,
  });

  if (shouldCrawl) {
    setCrawlStatus(storeId, "running");
    runCrawler(normalized, websiteUrl, storePassword)
      .then((crawledNormalized) => {
        const updatedFlags = detectAll(crawledNormalized, { crawlerRan: true });
        setData(storeId, crawledNormalized, updatedFlags, rawExtraction, { crawlerRan: true });
        setCrawlStatus(storeId, "complete");
        console.log(`Crawler complete for ${storeId}. Total flags: ${updatedFlags.length}`);
      })
      .catch((err) => {
        console.error(`Crawler failed for ${storeId}:`, err.message);
        setCrawlStatus(storeId, "failed");
        // Real ShopifyQL data already ingested remains valid and served.
      });
  }
});

module.exports = router;
