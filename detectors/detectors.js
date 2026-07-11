function round2(n) { return n == null ? null : Math.round(n * 100) / 100; }

// ─── Tunable thresholds ─────────────────────────────────────────────────────
// One place to change how sensitive the detectors are. Rationale for each
// default value is inline; override at runtime via detectAll(normalized,
// { crawlerRan, thresholds }).
const DEFAULTS = {
  // Minimum sessions before a page/source is statistically meaningful.
  // Bounce/conversion use 200 (matches typical retail traffic norms).
  minPageSessions: 200,
  minSourceSessions: 200,
  // CWV needs fewer sessions to be actionable — a single slow page still
  // matters even at 100 sessions.
  minCwvSessions: 100,
  // Layout signals are more anecdotal; require 300 sessions to reduce noise.
  minCtaSessions: 300,

  // Page bounce > 1.3× site average = flagged.
  bounceRateMultiplier: 1.3,
  // Page conversion < 0.5× site average = flagged.
  conversionRateMultiplier: 0.5,

  // A source is "poor quality" only if BOTH conditions hold: converts far
  // below site average AND bounces heavily.
  poorSourceConversionMultiplier: 0.4,
  poorSourceBounceMin: 0.6,

  // Cart abandonment > 70% flagged; > 80% escalates to severity 3.
  cartAbandonmentWarn: 0.7,
  cartAbandonmentSevere: 0.8,

  // Reached-checkout rate < 40% flagged; < 25% escalates to severity 3.
  checkoutReachWarn: 0.4,
  checkoutReachSevere: 0.25,

  // Revenue: > 15% drop across the middle of the window = flagged.
  revenueDeclineThreshold: -0.15,
  // A page needs 1000 sessions to escalate a bounce/conversion flag to sev 3.
  highTrafficPageSessions: 1000,
};

// ─── Detectors ──────────────────────────────────────────────────────────────
// Every detector takes (normalized, t) where t is the resolved threshold
// bundle. Rates are null-aware: a null value means "not measured" and never
// trips a threshold (previously null collapsed to 0 and caused spurious
// low-conversion flags).

function detectHighBouncePages(normalized, t) {
  const flags = [];
  const avgBounce = normalized.overview.bounceRate;
  if (avgBounce == null) return flags;
  for (const page of normalized.pages) {
    if (page.bounceRate == null) continue;
    if (page.sessions < t.minPageSessions) continue;
    if (page.bounceRate <= avgBounce * t.bounceRateMultiplier) continue;
    flags.push({
      type: "high_bounce_page",
      path: page.path,
      value: page.bounceRate,
      baseline: avgBounce,
      sessions: page.sessions,
      severity: page.sessions > t.highTrafficPageSessions ? 3 : 2,
      dataQuality: "real",
    });
  }
  return flags;
}

function detectLowConversionPages(normalized, t) {
  const flags = [];
  const avgCr = normalized.overview.conversionRate;
  if (avgCr == null || avgCr === 0) return flags;
  for (const page of normalized.pages) {
    if (page.conversionRate == null) continue;
    if (page.sessions < t.minPageSessions) continue;
    if (page.conversionRate >= avgCr * t.conversionRateMultiplier) continue;
    flags.push({
      type: "low_conversion_page",
      path: page.path,
      value: page.conversionRate,
      baseline: avgCr,
      sessions: page.sessions,
      severity: page.sessions > t.highTrafficPageSessions ? 3 : 2,
      dataQuality: "real",
    });
  }
  return flags;
}

function detectPoorQualityTrafficSource(normalized, t) {
  const flags = [];
  const avgCr = normalized.overview.conversionRate;
  if (avgCr == null || avgCr === 0) return flags;
  for (const source of normalized.traffic) {
    if (source.conversionRate == null || source.bounceRate == null) continue;
    if (source.sessions < t.minSourceSessions) continue;
    if (
      source.conversionRate < avgCr * t.poorSourceConversionMultiplier &&
      source.bounceRate > t.poorSourceBounceMin
    ) {
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

function detectCartAbandonment(normalized, t) {
  const flags = [];
  const rate = normalized.overview.cartAbandonmentRate;
  if (rate == null || rate <= t.cartAbandonmentWarn) return flags;
  flags.push({
    type: "high_cart_abandonment",
    value: rate,
    severity: rate > t.cartAbandonmentSevere ? 3 : 2,
    dataQuality: "real",
  });
  return flags;
}

function detectFunnelDropOff(normalized, t) {
  const flags = [];
  const f = normalized.funnel;
  if (!f || !f.sessions) return flags;
  if (f.checkoutReachRate == null || f.checkoutReachRate >= t.checkoutReachWarn) return flags;
  flags.push({
    type: "cart_to_checkout_dropoff",
    cartAdditions: f.sessionsWithCartAdditions,
    reachedCheckout: f.sessionsThatReachedCheckout,
    checkoutReachRate: f.checkoutReachRate,
    severity: f.checkoutReachRate < t.checkoutReachSevere ? 3 : 2,
    dataQuality: "real",
  });
  return flags;
}

function detectRevenueTrend(normalized, t) {
  const flags = [];
  const days = normalized.dailySales || [];
  if (days.length < 4) return flags;
  const mid = Math.floor(days.length / 2);
  const avgFirst = days.slice(0, mid).reduce((s, d) => s + d.sales, 0) / mid;
  const avgSecond = days.slice(mid).reduce((s, d) => s + d.sales, 0) / (days.length - mid);
  if (avgFirst <= 0) return flags;
  const change = (avgSecond - avgFirst) / avgFirst;
  if (change >= t.revenueDeclineThreshold) return flags;
  flags.push({
    type: "revenue_decline",
    changePercent: round2(change * 100),
    severity: 3,
    dataQuality: "real",
  });
  return flags;
}

// Poor Core Web Vitals — Google's own thresholds (baked into normalize.js's
// *Status fields), NOT tunable here.
function detectPoorCoreWebVitals(normalized, t) {
  const flags = [];
  for (const page of normalized.pages) {
    if (page.sessions < t.minCwvSessions) continue;
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

function detectCTABelowFold(normalized, t) {
  const flags = [];
  for (const page of normalized.pages) {
    if (!page.crawlerEnriched) continue;
    if (page.sessions < t.minCtaSessions) continue;
    if (page.ctaAboveFoldDesktop !== false && page.ctaAboveFoldMobile !== false) continue;
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
  return flags;
}

function detectAll(normalized, { crawlerRan = false, thresholds } = {}) {
  const t = { ...DEFAULTS, ...(thresholds || {}) };
  const flags = [
    ...detectHighBouncePages(normalized, t),
    ...detectLowConversionPages(normalized, t),
    ...detectPoorQualityTrafficSource(normalized, t),
    ...detectCartAbandonment(normalized, t),
    ...detectFunnelDropOff(normalized, t),
    ...detectRevenueTrend(normalized, t),
    ...detectPoorCoreWebVitals(normalized, t),
  ];
  if (crawlerRan) flags.push(...detectCTABelowFold(normalized, t));
  return flags.sort((a, b) => b.severity - a.severity);
}

module.exports = { detectAll, DEFAULTS };
