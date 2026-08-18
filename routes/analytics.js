const express = require("express");
const router = express.Router();
const { hasData, getData, getCrawlStatus, listStores } = require("../data/cache");
const { generateMockNormalized, generateMockFlags } = require("../data/mockGenerators");
const {
  overviewHighlights,
  trafficHighlights,
  devicesHighlights,
  pagesHighlights,
  funnelHighlights,
} = require("../utils/highlights");

function resolveNormalized(storeId) {
  if (hasData(storeId)) {
    const cached = getData(storeId);
    return { normalized: cached.normalized, flags: cached.flags, cached, dataSource: "shopify" };
  }
  const normalized = generateMockNormalized(storeId);
  const flags = generateMockFlags(normalized);
  return { normalized, flags, cached: null, dataSource: "mock" };
}

// ─── Health ──────────────────────────────────────────────────────────────────

router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "analytics-service",
    version: "4.0.0",
    timestamp: new Date().toISOString(),
    storesWithRealData: listStores(),
  });
});

// ─── Status ──────────────────────────────────────────────────────────────────

router.get("/api/analytics/status", (req, res) => {
  const storeId = req.query.storeId || "test-store";
  if (hasData(storeId)) {
    const cached = getData(storeId);
    return res.json({
      storeId,
      dataSource: "shopify",
      ingestedAt: cached.ingestedAt,
      queriesRun: cached.rawExtraction.queriesRun,
      metrics: cached.rawExtraction.metrics,
      crawlerRan: cached.crawlerRan,
      crawlerStatus: getCrawlStatus(storeId) || (cached.crawlerRan ? "complete" : "not_triggered"),
    });
  }
  res.json({
    storeId,
    dataSource: "mock",
    ingestedAt: null,
    crawlerRan: false,
    crawlerStatus: "not_triggered",
    message: "No real data. Sync via Shopify plugin to fetch real data.",
  });
});

// ─── Full report ─────────────────────────────────────────────────────────────

router.get("/api/analytics/report", (req, res) => {
  const storeId = req.query.storeId || "test-store";
  const { normalized, flags, cached, dataSource } = resolveNormalized(storeId);
  res.json({
    storeId,
    dataSource,
    ingestedAt: cached?.ingestedAt || null,
    crawlerRan: cached?.crawlerRan || false,
    normalized,
    flags,
  });
});

// ─── Overview ────────────────────────────────────────────────────────────────

router.get("/api/analytics/overview", (req, res) => {
  const storeId = req.query.storeId || "test-store";
  const { normalized, flags, cached, dataSource } = resolveNormalized(storeId);
  res.json({
    storeId,
    dataSource,
    ingestedAt: cached?.ingestedAt || null,
    crawlerRan: cached?.crawlerRan || false,
    period: normalized.period,
    fetchedAt: normalized.fetchedAt,
    summary: overviewHighlights(normalized, flags),
    overview: normalized.overview,
    dailyOverview: normalized.dailyOverview,
    dailySales: normalized.dailySales,
    flags: flags.filter((f) =>
      ["revenue_decline", "high_cart_abandonment"].includes(f.type)
    ),
  });
});

// ─── Traffic ─────────────────────────────────────────────────────────────────

router.get("/api/analytics/traffic", (req, res) => {
  const storeId = req.query.storeId || "test-store";
  const { normalized, flags, cached, dataSource } = resolveNormalized(storeId);
  res.json({
    storeId,
    dataSource,
    ingestedAt: cached?.ingestedAt || null,
    crawlerRan: cached?.crawlerRan || false,
    period: normalized.period,
    fetchedAt: normalized.fetchedAt,
    summary: trafficHighlights(normalized, flags),
    traffic: normalized.traffic,
    flags: flags.filter((f) => f.type === "poor_quality_traffic_source"),
  });
});

// ─── Devices ─────────────────────────────────────────────────────────────────

router.get("/api/analytics/devices", (req, res) => {
  const storeId = req.query.storeId || "test-store";
  const { normalized, flags, cached, dataSource } = resolveNormalized(storeId);
  res.json({
    storeId,
    dataSource,
    ingestedAt: cached?.ingestedAt || null,
    crawlerRan: cached?.crawlerRan || false,
    period: normalized.period,
    fetchedAt: normalized.fetchedAt,
    summary: devicesHighlights(normalized),
    devices: normalized.devices,
    flags: [],
  });
});

// ─── Pages ───────────────────────────────────────────────────────────────────

router.get("/api/analytics/pages", (req, res) => {
  const storeId = req.query.storeId || "test-store";
  const { normalized, flags, cached, dataSource } = resolveNormalized(storeId);
  res.json({
    storeId,
    dataSource,
    ingestedAt: cached?.ingestedAt || null,
    crawlerRan: cached?.crawlerRan || false,
    period: normalized.period,
    fetchedAt: normalized.fetchedAt,
    summary: pagesHighlights(normalized, flags),
    pages: normalized.pages,
    flags: flags.filter((f) =>
      ["high_bounce_page", "low_conversion_page", "poor_lcp",
       "lcp_needs_improvement", "poor_cls", "poor_inp", "cta_below_fold"].includes(f.type)
    ),
  });
});

// ─── Funnel ──────────────────────────────────────────────────────────────────

router.get("/api/analytics/funnel", (req, res) => {
  const storeId = req.query.storeId || "test-store";
  const { normalized, flags, cached, dataSource } = resolveNormalized(storeId);
  res.json({
    storeId,
    dataSource,
    ingestedAt: cached?.ingestedAt || null,
    crawlerRan: cached?.crawlerRan || false,
    period: normalized.period,
    fetchedAt: normalized.fetchedAt,
    summary: funnelHighlights(normalized, flags),
    funnel: normalized.funnel,
    flags: flags.filter((f) =>
      ["high_cart_abandonment", "cart_to_checkout_dropoff"].includes(f.type)
    ),
  });
});

module.exports = router;
