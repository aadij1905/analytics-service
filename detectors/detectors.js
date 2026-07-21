function round2(n) { return n == null ? null : Math.round(n * 100) / 100; }

// One-sample z-test for a proportion: how many standard errors the observed
// page/source rate (pHat over n sessions) sits from the site baseline (p0).
// This is what lets us flag a low-traffic page without a large minSessions
// floor — a wild-looking rate over 6 sessions produces a small |z| (likely
// noise) while the same rate over 6000 sessions produces a large one (real
// signal). Returns 0 when the inputs can't support a test.
function zTestProportion(pHat, p0, n) {
  if (pHat == null || p0 == null || p0 <= 0 || p0 >= 1 || !(n > 0)) return 0;
  const se = Math.sqrt((p0 * (1 - p0)) / n);
  if (se === 0) return 0;
  return (pHat - p0) / se;
}

// ─── Tunable thresholds ─────────────────────────────────────────────────────
// One place to change how sensitive the detectors are. Rationale for each
// default value is inline; override at runtime via detectAll(normalized,
// { crawlerRan, thresholds }).
const DEFAULTS = {
  // Hard floor on sessions before a page/source is even considered — just
  // enough to reject n=1..4 where a z-test is meaningless. The real
  // noise-vs-signal decision is now the significance test (significanceZ
  // below), so this no longer needs to be a large, traffic-tuned number the
  // way a raw-multiplier gate did — it stays low safely for any store size.
  minPageSessions: 5,
  minSourceSessions: 5,
  // CWV needs fewer sessions to be actionable — a single slow page still
  // matters even at 100 sessions.
  minCwvSessions: 3,
  // Layout signals are more anecdotal; require 300 sessions to reduce noise.
  minCtaSessions: 5,

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

  // Minimum z-score for a page/source rate to count as significantly worse
  // than the site baseline (one-sided ≈ 95% confidence). Raise to ~2.33 for
  // ≈99% (fewer, higher-confidence flags); lower toward ~1.28 to surface more.
  significanceZ: 1.645,
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
    if (page.bounceRate <= avgBounce * t.bounceRateMultiplier) continue; // effect size
    const z = zTestProportion(page.bounceRate, avgBounce, page.sessions);
    if (z < t.significanceZ) continue; // the gap could be sampling noise
    flags.push({
      type: "high_bounce_page",
      path: page.path,
      value: page.bounceRate,
      baseline: avgBounce,
      sessions: page.sessions,
      zScore: round2(z),
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
    if (page.conversionRate >= avgCr * t.conversionRateMultiplier) continue; // effect size
    const z = zTestProportion(page.conversionRate, avgCr, page.sessions);
    if (z > -t.significanceZ) continue; // below baseline, but maybe just noise
    flags.push({
      type: "low_conversion_page",
      path: page.path,
      value: page.conversionRate,
      baseline: avgCr,
      sessions: page.sessions,
      zScore: round2(z),
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
    const z = zTestProportion(source.conversionRate, avgCr, source.sessions);
    if (
      source.conversionRate < avgCr * t.poorSourceConversionMultiplier &&
      source.bounceRate > t.poorSourceBounceMin &&
      z <= -t.significanceZ // conversion gap is significant, not small-sample noise
    ) {
      flags.push({
        type: "poor_quality_traffic_source",
        source: source.source,
        conversionRate: source.conversionRate,
        bounceRate: source.bounceRate,
        sessions: source.sessions,
        zScore: round2(z),
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
  // The first-half vs second-half comparison below is only meaningful if the
  // rows are in chronological order — nothing upstream guarantees that, and
  // unordered rows silently produce false or missed decline flags. Sort by
  // day first (ISO YYYY-MM-DD sorts correctly as strings).
  const days = [...(normalized.dailySales || [])]
    .filter((d) => d && d.day)
    .sort((a, b) => String(a.day).localeCompare(String(b.day)));
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

// Flags on the SAME page are often causally linked (e.g. poor_lcp driving
// high_bounce). Tag each with the other flag types sharing its page so
// downstream (the AI service) can treat them as one story instead of N
// independent findings. Additive — never removes or merges flags here.
function annotateCorrelations(flags) {
  const byPath = new Map();
  for (const f of flags) {
    if (!f.path) continue;
    if (!byPath.has(f.path)) byPath.set(f.path, []);
    byPath.get(f.path).push(f);
  }
  for (const group of byPath.values()) {
    if (group.length < 2) continue;
    for (const f of group) {
      f.coOccurringOnPage = group.filter((g) => g !== f).map((g) => g.type);
    }
  }
}

// Rank by severity first, then by how many sessions the issue actually touches
// (a page flag's own sessions; a site-wide flag inherits total sessions) so a
// sev-2 on a 5000-session page outranks a sev-2 on a 6-session page. The AI
// service ranks off this order, so getting it right here compounds downstream.
function scoreAndSort(flags, normalized) {
  const siteSessions = (normalized.overview && normalized.overview.totalSessions) || 0;
  for (const f of flags) {
    const weight = f.sessions != null ? f.sessions : siteSessions;
    f.impactScore = f.severity * weight;
  }
  return flags.sort((a, b) => (b.severity - a.severity) || (b.impactScore - a.impactScore));
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
  annotateCorrelations(flags);
  return scoreAndSort(flags, normalized);
}

module.exports = { detectAll, DEFAULTS };
