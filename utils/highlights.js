function fmt(n, type) {
  if (n == null) return null;
  if (type === "pct") return `${(n * 100).toFixed(1)}%`;
  if (type === "ms") return `${(n / 1000).toFixed(1)}s`;
  if (type === "currency") return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : n.toFixed(0);
  return n;
}

function overviewHighlights(normalized, flags) {
  const o = normalized.overview;
  const problems = [];

  if (o.bounceRate > 0.5)
    problems.push(`High bounce (${fmt(o.bounceRate, "pct")})`);

  const worstLcp = normalized.pages
    .filter((p) => p.lcp_p75_ms && p.sessions >= 100)
    .sort((a, b) => b.lcp_p75_ms - a.lcp_p75_ms)[0];
  if (worstLcp && worstLcp.lcp_p75_ms > 2500)
    problems.push(`Slow load (${fmt(worstLcp.lcp_p75_ms, "ms")})`);

  if (o.cartAbandonmentRate > 0.65)
    problems.push(`Cart abandonment (${fmt(o.cartAbandonmentRate, "pct")})`);

  if (flags.some((f) => f.type === "revenue_decline"))
    problems.push(`Revenue declining ${Math.abs(flags.find((f) => f.type === "revenue_decline").changePercent)}% week-on-week`);

  return {
    section: "Overview",
    highlights: `${o.totalSessions.toLocaleString()} sessions, ${fmt(o.totalRevenue, "currency")} revenue, ${fmt(o.conversionRate, "pct")} conversion`,
    problems: problems.length ? problems.join(", ") : "No critical issues detected",
    keyMetrics: {
      totalSessions: o.totalSessions,
      totalRevenue: o.totalRevenue,
      totalOrders: o.totalOrders,
      avgOrderValue: o.avgOrderValue,
      conversionRate: fmt(o.conversionRate, "pct"),
      bounceRate: fmt(o.bounceRate, "pct"),
      cartAbandonmentRate: o.cartAbandonmentRate != null ? fmt(o.cartAbandonmentRate, "pct") : null,
    },
  };
}

function trafficHighlights(normalized, flags) {
  const sources = normalized.traffic;
  const sorted = [...sources].sort((a, b) => b.sessions - a.sessions);
  const sourceNames = sorted.map((s) => s.source).join(", ");
  const poorSources = flags
    .filter((f) => f.type === "poor_quality_traffic_source")
    .map((f) => f.source);

  const best = sorted.reduce((b, s) => (!b || s.conversionRate > b.conversionRate ? s : b), null);
  const worst = sorted.reduce((w, s) => (!w || s.conversionRate < w.conversionRate ? s : w), null);

  return {
    section: "Traffic",
    highlights: `${sources.length} sources — ${sourceNames}`,
    problems: poorSources.length
      ? `Poor quality: ${poorSources.join(", ")} (low CR + high bounce)`
      : "All traffic sources within acceptable range",
    keyMetrics: {
      sourceCount: sources.length,
      topSource: sorted[0]?.source,
      topSourceSessions: sorted[0]?.sessions,
      bestConvertingSource: best ? `${best.source} (${fmt(best.conversionRate, "pct")})` : null,
      worstConvertingSource: worst ? `${worst.source} (${fmt(worst.conversionRate, "pct")})` : null,
      poorQualitySources: poorSources,
    },
  };
}

function devicesHighlights(normalized) {
  const devices = normalized.devices;
  const entries = Object.entries(devices).sort((a, b) => b[1].sessions - a[1].sessions);
  const dominant = entries[0];
  const rest = entries.slice(1);

  const dominantLabel = dominant
    ? `${(dominant[1].percentage * 100).toFixed(0)}% ${dominant[0]}`
    : null;
  const restLabel = rest
    .map(([k, v]) => `${(v.percentage * 100).toFixed(0)}% ${k}`)
    .join(", ");

  return {
    section: "Devices",
    highlights: `${dominantLabel}${restLabel ? " vs " + restLabel : ""}`,
    problems: "Per-device bounce rate and conversion rate not available from ShopifyQL",
    keyMetrics: {
      breakdown: entries.map(([device, d]) => ({
        device,
        sessions: d.sessions,
        percentage: fmt(d.percentage, "pct"),
        onlineStoreVisitors: d.onlineStoreVisitors,
        conversionRate: null,
        bounceRate: null,
        note: "requiresAdditionalQuery",
      })),
      dominantDevice: dominant?.[0],
      dominantPercentage: dominant ? fmt(dominant[1].percentage, "pct") : null,
    },
  };
}

function pagesHighlights(normalized, flags) {
  const pages = normalized.pages;
  const sorted = [...pages].sort((a, b) => b.sessions - a.sessions);

  const worstBounce = flags
    .filter((f) => f.type === "high_bounce_page")
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 3)
    .map((f) => f.path.split("/").filter(Boolean).pop() || "homepage");

  const poorPerf = pages.filter((p) => p.lcpStatus === "poor" || p.inpStatus === "poor");

  return {
    section: "Pages",
    highlights: `${pages.length} pages — ${sorted.map((p) => p.path.split("/").filter(Boolean)[0] || "homepage").join(", ")}`,
    problems: [
      worstBounce.length ? `High bounce: ${worstBounce.join(", ")}` : null,
      poorPerf.length ? `Poor CWV: ${poorPerf.map((p) => p.path).join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("; ") || "No critical page issues",
    keyMetrics: {
      pageCount: pages.length,
      topPageByTraffic: sorted[0]?.path,
      avgBounceRate: fmt(
        pages.reduce((s, p) => s + p.bounceRate, 0) / pages.length,
        "pct"
      ),
      avgConversionRate: fmt(
        pages.reduce((s, p) => s + p.conversionRate, 0) / pages.length,
        "pct"
      ),
      worstBouncePages: flags
        .filter((f) => f.type === "high_bounce_page")
        .map((f) => ({ path: f.path, bounceRate: fmt(f.value, "pct"), sessions: f.sessions })),
      pagesWithPoorCWV: poorPerf.map((p) => ({
        path: p.path,
        lcpStatus: p.lcpStatus,
        clsStatus: p.clsStatus,
        inpStatus: p.inpStatus,
      })),
    },
  };
}

function funnelHighlights(normalized, flags) {
  const f = normalized.funnel;

  // Find the biggest drop-off stage
  const stages = [
    { from: "Sessions",          to: "Added to Cart",      rate: f.cartAdditionRate,        count: f.sessionsWithCartAdditions },
    { from: "Added to Cart",     to: "Reached Checkout",   rate: f.checkoutReachRate,        count: f.sessionsThatReachedCheckout },
    { from: "Reached Checkout",  to: "Completed Purchase", rate: f.checkoutCompletionRate,   count: f.sessionsThatCompletedCheckout },
  ];

  const biggestDrop = stages
    .filter((s) => s.rate != null)
    .sort((a, b) => a.rate - b.rate)[0];

  const dropOffPct = biggestDrop ? fmt(1 - biggestDrop.rate, "pct") : null;
  const dropOffLabel = biggestDrop
    ? `${biggestDrop.from}→${biggestDrop.to} (${dropOffPct} drop-off)`
    : null;

  return {
    section: "Funnel",
    highlights: `${stages.length + 1} stages with biggest drop-off at ${dropOffLabel}`,
    problems: flags
      .filter((f) => ["high_cart_abandonment", "cart_to_checkout_dropoff"].includes(f.type))
      .map((f) =>
        f.type === "high_cart_abandonment"
          ? `Cart abandonment ${fmt(f.value, "pct")}`
          : `Cart→Checkout drop-off ${fmt(1 - f.checkoutReachRate, "pct")}`
      )
      .join(", ") || "Funnel within acceptable range",
    keyMetrics: {
      totalSessions: f.sessions,
      sessionsWithCartAdditions: f.sessionsWithCartAdditions,
      sessionsThatReachedCheckout: f.sessionsThatReachedCheckout,
      sessionsThatCompletedCheckout: f.sessionsThatCompletedCheckout,
      cartAdditionRate: fmt(f.cartAdditionRate, "pct"),
      checkoutReachRate: fmt(f.checkoutReachRate, "pct"),
      checkoutCompletionRate: fmt(f.checkoutCompletionRate, "pct"),
      overallConversionRate: fmt(f.conversionRate, "pct"),
      biggestDropOff: dropOffLabel,
      stages: [
        { stage: "Sessions",           count: f.sessions,                        rate: "100%" },
        { stage: "Added to Cart",      count: f.sessionsWithCartAdditions,       rate: fmt(f.cartAdditionRate, "pct") },
        { stage: "Reached Checkout",   count: f.sessionsThatReachedCheckout,     rate: fmt(f.checkoutReachRate, "pct") },
        { stage: "Completed Purchase", count: f.sessionsThatCompletedCheckout,   rate: fmt(f.checkoutCompletionRate, "pct") },
      ],
    },
  };
}

module.exports = {
  overviewHighlights,
  trafficHighlights,
  devicesHighlights,
  pagesHighlights,
  funnelHighlights,
};
