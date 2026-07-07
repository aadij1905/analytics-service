// Mock data mirrors real normalized output shape exactly.
// Fields that are null in real ShopifyQL output are null here too.
// Do NOT make mock data richer than real data can be.
const { detectAll } = require("../detectors/detectors");

function generateMockNormalized(storeId) {
  return {
    period: "7d",
    fetchedAt: new Date().toISOString(),
    dataSource: "mock",
    websiteUrl: null,
    overview: {
      totalSessions: 11200,
      totalRevenue: 28400.50,
      totalOrders: 198,
      avgOrderValue: 143.43,
      conversionRate: 0.0177,
      bounceRate: 0.44,
      cartAbandonmentRate: 0.72,
      avgPageLoadTime: null,
    },
    dailyOverview: Array.from({ length: 7 }, (_, i) => ({
      day: `2026-06-${22 + i}`,
      sessions: 1500 + i * 80,
      conversionRate: 0.015 + i * 0.001,
      bounceRate: 0.42 + i * 0.005,
    })),
    dailySales: Array.from({ length: 7 }, (_, i) => ({
      day: `2026-06-${22 + i}`,
      sales: 4000 - i * 200,
      orders: 28 - i,
      aov: 142,
    })),
    funnel: {
      sessions: 11200,
      sessionsWithCartAdditions: 2240,
      sessionsThatReachedCheckout: 896,
      sessionsThatCompletedCheckout: 198,
      conversionRate: 0.0177,
      cartAdditionRate: 0.2,
      checkoutReachRate: 0.4,
      checkoutCompletionRate: 0.22,
      dailyFunnel: [],
    },
    traffic: [
      { source: "organic",  sessions: 3920, conversionRate: 0.021, bounceRate: 0.35 },
      { source: "social",   sessions: 2912, conversionRate: 0.012, bounceRate: 0.58 },
      { source: "direct",   sessions: 2240, conversionRate: 0.019, bounceRate: 0.41 },
      { source: "paid",     sessions: 1344, conversionRate: 0.008, bounceRate: 0.71 },
      { source: "referral", sessions: 784,  conversionRate: 0.023, bounceRate: 0.31 },
    ],
    devices: {
      mobile:  { sessions: 7840, onlineStoreVisitors: 7200, percentage: 0.70, conversionRate: null, bounceRate: null, avgPageLoadTime: null, requiresAdditionalQuery: true },
      desktop: { sessions: 2912, onlineStoreVisitors: 2800, percentage: 0.26, conversionRate: null, bounceRate: null, avgPageLoadTime: null, requiresAdditionalQuery: true },
      tablet:  { sessions: 448,  onlineStoreVisitors: 420,  percentage: 0.04, conversionRate: null, bounceRate: null, avgPageLoadTime: null, requiresAdditionalQuery: true },
    },
    pages: [
      {
        path: "/",
        sessions: 3850, conversionRate: 0.018, bounceRate: 0.38,
        lcp_p75_ms: 2800, p75_cls: 0.12, inp_p75_ms: 210,
        lcpStatus: "needs_improvement", clsStatus: "needs_improvement", inpStatus: "needs_improvement",
        ctaText: null, ctaAboveFoldDesktop: null, ctaAboveFoldMobile: null,
        hasSocialProof: null, scrollDepth: null, screenshotPath: null, crawlerEnriched: false,
      },
      {
        path: "/products/wireless-earbuds-pro",
        sessions: 740, conversionRate: 0.008, bounceRate: 0.62,
        lcp_p75_ms: 4500, p75_cls: 0.05, inp_p75_ms: 180,
        lcpStatus: "poor", clsStatus: "good", inpStatus: "good",
        ctaText: null, ctaAboveFoldDesktop: null, ctaAboveFoldMobile: null,
        hasSocialProof: null, scrollDepth: null, screenshotPath: null, crawlerEnriched: false,
      },
      {
        path: "/collections/all",
        sessions: 620, conversionRate: 0.005, bounceRate: 0.55,
        lcp_p75_ms: 3100, p75_cls: 0.08, inp_p75_ms: 160,
        lcpStatus: "needs_improvement", clsStatus: "good", inpStatus: "good",
        ctaText: null, ctaAboveFoldDesktop: null, ctaAboveFoldMobile: null,
        hasSocialProof: null, scrollDepth: null, screenshotPath: null, crawlerEnriched: false,
      },
    ],
  };
}

function generateMockFlags(normalized) {
  return detectAll(normalized, { crawlerRan: false });
}

module.exports = { generateMockNormalized, generateMockFlags };
