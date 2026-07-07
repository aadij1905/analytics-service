function toNumber(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function round2(n) { return Math.round(n * 100) / 100; }

// Detector 1: High bounce pages — real bounce_rate per landing_page_path
function detectHighBouncePages(normalized) {
  const flags = [];
  const avgBounce = normalized.overview.bounceRate;
  for (const page of normalized.pages) {
    if (page.sessions > 200 && page.bounceRate > avgBounce * 1.3) {
      flags.push({
        type: "high_bounce_page",
        path: page.path,
        value: page.bounceRate,
        baseline: avgBounce,
        sessions: page.sessions,
        severity: page.sessions > 1000 ? 3 : 2,
        dataQuality: "real",
      });
    }
  }
  return flags;
}

// Detector 2: Low conversion pages — real conversion_rate per landing_page_path
function detectLowConversionPages(normalized) {
  const flags = [];
  const avgCr = normalized.overview.conversionRate;
  for (const page of normalized.pages) {
    if (page.sessions > 200 && page.conversionRate < avgCr * 0.5) {
      flags.push({
        type: "low_conversion_page",
        path: page.path,
        value: page.conversionRate,
        baseline: avgCr,
        sessions: page.sessions,
        severity: page.sessions > 1000 ? 3 : 2,
        dataQuality: "real",
      });
    }
  }
  return flags;
}

// Detector 3: Poor quality traffic source — real conversion_rate + bounce_rate per referrer_source
function detectPoorQualityTrafficSource(normalized) {
  const flags = [];
  const avgCr = normalized.overview.conversionRate;
  for (const source of normalized.traffic) {
    if (source.sessions > 200 && source.conversionRate < avgCr * 0.4 && source.bounceRate > 0.6) {
      flags.push({
        type: "poor_quality_traffic_source",
        source: source.source,
        conversionRate: source.conversionRate,
        bounceRate: source.bounceRate,
        sessions: source.sessions,
        severity: 3,
        dataQuality: "real",
      });
    }
  }
  return flags;
}

// Detector 4: Cart abandonment — real, derived from checkout_conversion_rate
function detectCartAbandonment(normalized) {
  const flags = [];
  const rate = normalized.overview.cartAbandonmentRate;
  if (rate != null && rate > 0.70) {
    flags.push({
      type: "high_cart_abandonment",
      value: rate,
      severity: rate > 0.80 ? 3 : 2,
      dataQuality: "real",
    });
  }
  return flags;
}

// Detector 5: Funnel drop-off — real from sessions_with_cart_additions etc.
function detectFunnelDropOff(normalized) {
  const flags = [];
  const f = normalized.funnel;
  if (!f || !f.sessions) return flags;
  if (f.checkoutReachRate != null && f.checkoutReachRate < 0.4) {
    flags.push({
      type: "cart_to_checkout_dropoff",
      cartAdditions: f.sessionsWithCartAdditions,
      reachedCheckout: f.sessionsThatReachedCheckout,
      checkoutReachRate: f.checkoutReachRate,
      severity: f.checkoutReachRate < 0.25 ? 3 : 2,
      dataQuality: "real",
    });
  }
  return flags;
}

// Detector 6: Revenue decline — real daily sales data
function detectRevenueTrend(normalized) {
  const flags = [];
  const days = normalized.dailySales;
  if (days.length >= 4) {
    const mid = Math.floor(days.length / 2);
    const avgFirst = days.slice(0, mid).reduce((s, d) => s + d.sales, 0) / mid;
    const avgSecond = days.slice(mid).reduce((s, d) => s + d.sales, 0) / (days.length - mid);
    if (avgFirst > 0 && (avgSecond - avgFirst) / avgFirst < -0.15) {
      flags.push({
        type: "revenue_decline",
        changePercent: round2(((avgSecond - avgFirst) / avgFirst) * 100),
        severity: 3,
        dataQuality: "real",
      });
    }
  }
  return flags;
}

// Detector 7: Poor Core Web Vitals — real lcp_p75_ms / p75_cls / inp_p75_ms
// Thresholds per Google: LCP good ≤2500ms, NI ≤4000ms, poor >4000ms
//                        CLS good ≤0.1, NI ≤0.25, poor >0.25
//                        INP good ≤200ms, NI ≤500ms, poor >500ms
function detectPoorCoreWebVitals(normalized) {
  const flags = [];
  for (const page of normalized.pages) {
    if (page.sessions < 100) continue;
    if (page.lcpStatus === "poor") {
      flags.push({
        type: "poor_lcp",
        path: page.path,
        value: page.lcp_p75_ms,
        sessions: page.sessions,
        severity: 3,
        dataQuality: "real",
        note: "LCP > 4000ms. Google threshold: good ≤ 2500ms.",
      });
    } else if (page.lcpStatus === "needs_improvement") {
      flags.push({
        type: "lcp_needs_improvement",
        path: page.path,
        value: page.lcp_p75_ms,
        sessions: page.sessions,
        severity: 2,
        dataQuality: "real",
        note: "LCP between 2500ms and 4000ms.",
      });
    }
    if (page.clsStatus === "poor") {
      flags.push({
        type: "poor_cls",
        path: page.path,
        value: page.p75_cls,
        sessions: page.sessions,
        severity: 2,
        dataQuality: "real",
        note: "CLS > 0.25. Google threshold: good ≤ 0.1.",
      });
    }
    if (page.inpStatus === "poor") {
      flags.push({
        type: "poor_inp",
        path: page.path,
        value: page.inp_p75_ms,
        sessions: page.sessions,
        severity: 2,
        dataQuality: "real",
        note: "INP > 500ms. Google threshold: good ≤ 200ms.",
      });
    }
  }
  return flags;
}

// Detector 8: CTA below fold — crawler only
function detectCTABelowFold(normalized) {
  const flags = [];
  for (const page of normalized.pages) {
    if (
      page.crawlerEnriched &&
      page.sessions > 300 &&
      (page.ctaAboveFoldDesktop === false || page.ctaAboveFoldMobile === false)
    ) {
      flags.push({
        type: "cta_below_fold",
        path: page.path,
        ctaAboveFoldDesktop: page.ctaAboveFoldDesktop,
        ctaAboveFoldMobile: page.ctaAboveFoldMobile,
        sessions: page.sessions,
        severity: 3,
        dataQuality: "real",
        source: "crawler",
      });
    }
  }
  return flags;
}

function detectAll(normalized, { crawlerRan } = {}) {
  const flags = [
    ...detectHighBouncePages(normalized),
    ...detectLowConversionPages(normalized),
    ...detectPoorQualityTrafficSource(normalized),
    ...detectCartAbandonment(normalized),
    ...detectFunnelDropOff(normalized),
    ...detectRevenueTrend(normalized),
    ...detectPoorCoreWebVitals(normalized),
  ];
  if (crawlerRan) {
    flags.push(...detectCTABelowFold(normalized));
  }
  return flags.sort((a, b) => b.severity - a.severity);
}

module.exports = { detectAll };
