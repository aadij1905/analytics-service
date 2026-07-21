// toCount: missing/NaN counts default to 0 (safe for sums).
// toRate: missing/NaN rates stay null so detectors know it's "not measured",
// not "measured as zero" — a real distinction that was silently collapsing.
function toCount(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}
function toRate(v) {
  if (v == null || v === "") return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}
function sumField(rows, field) {
  return rows.reduce((s, r) => s + toCount(r[field]), 0);
}
function avgWeighted(rows, valueField, weightField) {
  const totalWeight = sumField(rows, weightField);
  if (!totalWeight) return 0;
  return rows.reduce(
    (s, r) => s + toCount(r[valueField]) * toCount(r[weightField]),
    0,
  ) / totalWeight;
}
function round2(n) { return n == null ? null : Math.round(n * 100) / 100; }
function round4(n) { return n == null ? null : Math.round(n * 10000) / 10000; }

// Path normalization for the CWV → pages join. Strips trailing slash, query
// string, and case so /Products/foo, /products/foo/, and /products/foo?v=1
// join to the same key.
function normalizePath(p) {
  if (p == null) return null;
  let s = String(p).trim().toLowerCase();
  const q = s.indexOf("?");
  if (q !== -1) s = s.slice(0, q);
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

// Traffic source names come from ShopifyQL as-is: "Google", "google",
// "Google / organic" — group them so downstream doesn't split one source
// into three rows.
function normalizeSource(name) {
  if (!name) return "unknown";
  return String(name).trim().toLowerCase().split(/[\s/]+/)[0];
}

function normalize(rawExtraction) {
  // A ShopifyQL extraction can arrive partial: any individual sub-query may
  // fail upstream and come back missing OR null (not just omitted). Coerce
  // every field to an array up front so one failed query degrades that
  // section to empty instead of throwing and 500-ing the whole ingest —
  // losing the queries that *did* succeed. (Destructuring defaults only cover
  // undefined, not null, so this explicit guard is needed.)
  const raw = rawExtraction.raw || {};
  const asArr = (v) => (Array.isArray(v) ? v : []);
  const overviewRows = asArr(raw.overview);
  const sales = asArr(raw.sales);
  const pages = asArr(raw.pages);
  const trafficSources = asArr(raw.trafficSources);
  const devices = asArr(raw.devices);
  const funnelBreakdown = asArr(raw.funnelBreakdown);
  const checkoutConversion = asArr(raw.checkoutConversion);
  const performanceLCP = asArr(raw.performanceLCP);
  const performanceCLS = asArr(raw.performanceCLS);
  const performanceINP = asArr(raw.performanceINP);

  // Site-wide overview
  const totalSessions = sumField(overviewRows, "sessions");
  const totalSales = sumField(sales, "total_sales");
  const totalOrders = sumField(sales, "orders");
  const avgOrderValue = totalOrders ? totalSales / totalOrders : 0;
  const overallConversionRate = avgWeighted(overviewRows, "conversion_rate", "sessions");
  const overallBounceRate = avgWeighted(overviewRows, "bounce_rate", "sessions");

  // Cart abandonment derived from real checkout_conversion_rate.
  // Real data rows may not carry a sessions field — fall back to simple average.
  const avgCheckoutConversion = (() => {
    if (!checkoutConversion || !checkoutConversion.length) return null;
    const totalWeight = sumField(checkoutConversion, "sessions");
    if (totalWeight > 0) return avgWeighted(checkoutConversion, "checkout_conversion_rate", "sessions");
    const rates = checkoutConversion
      .map((r) => toRate(r.checkout_conversion_rate))
      .filter((n) => n != null && n > 0);
    return rates.length ? rates.reduce((s, n) => s + n, 0) / rates.length : null;
  })();
  const cartAbandonmentRate =
    avgCheckoutConversion != null ? round4(1 - avgCheckoutConversion) : null;

  // Funnel stages — confirmed ShopifyQL field names.
  // Real data comes as daily rows with no "total" row — sum across all days.
  const funnelTotals = funnelBreakdown.find((r) => r.day === "total") || {
    sessions: sumField(funnelBreakdown, "sessions"),
    sessions_with_cart_additions: sumField(funnelBreakdown, "sessions_with_cart_additions"),
    sessions_that_reached_checkout: sumField(funnelBreakdown, "sessions_that_reached_checkout"),
    sessions_that_completed_checkout: sumField(funnelBreakdown, "sessions_that_completed_checkout"),
  };
  // Single source of truth for sessions: prefer overview (canonical), fall back
  // to funnel totals. Old code did the reverse which could disagree.
  const funnelSessions = totalSessions || toCount(funnelTotals.sessions);
  const cartAdditions = toCount(funnelTotals.sessions_with_cart_additions);
  const reachedCheckout = toCount(funnelTotals.sessions_that_reached_checkout);
  const completedCheckout = toCount(funnelTotals.sessions_that_completed_checkout);

  const funnelNormalized = {
    sessions: funnelSessions,
    sessionsWithCartAdditions: cartAdditions,
    sessionsThatReachedCheckout: reachedCheckout,
    sessionsThatCompletedCheckout: completedCheckout,
    conversionRate: round4(overallConversionRate),
    cartAdditionRate: funnelSessions ? round4(cartAdditions / funnelSessions) : null,
    checkoutReachRate: cartAdditions ? round4(reachedCheckout / cartAdditions) : null,
    checkoutCompletionRate: reachedCheckout ? round4(completedCheckout / reachedCheckout) : null,
    dailyFunnel: funnelBreakdown
      .filter((r) => r.day && r.day !== "total")
      .map((r) => ({
        day: r.day,
        sessions: toCount(r.sessions),
        cartAdditions: toCount(r.sessions_with_cart_additions),
        reachedCheckout: toCount(r.sessions_that_reached_checkout),
        completedCheckout: toCount(r.sessions_that_completed_checkout),
      })),
  };

  // Performance lookup maps keyed by normalized page path (web_performance).
  // Old code joined raw strings — trailing slash / case / query string
  // mismatches silently dropped CWV per page.
  const lcpByPath = {};
  for (const r of (performanceLCP || [])) {
    lcpByPath[normalizePath(r.page_path)] = { lcp_p75_ms: toRate(r.lcp_p75_ms) };
  }
  const clsByPath = {};
  for (const r of (performanceCLS || [])) {
    clsByPath[normalizePath(r.page_path)] = { p75_cls: toRate(r.p75_cls) };
  }
  const inpByPath = {};
  for (const r of (performanceINP || [])) {
    inpByPath[normalizePath(r.page_path)] = { inp_p75_ms: toRate(r.inp_p75_ms) };
  }

  // Pages
  const pagesNormalized = pages.map((row) => {
    const rawPath = row.landing_page_path;
    const key = normalizePath(rawPath);
    const lcpEntry = lcpByPath[key];
    const clsEntry = clsByPath[key];
    const inpEntry = inpByPath[key];
    return {
      path: rawPath,
      sessions: toCount(row.sessions),
      // Rates: preserve null so downstream detectors distinguish
      // "no measurement" from "measured as zero".
      conversionRate: round4(toRate(row.conversion_rate)),
      bounceRate: round4(toRate(row.bounce_rate)),
      lcp_p75_ms: lcpEntry?.lcp_p75_ms ?? null,
      p75_cls: clsEntry?.p75_cls ?? null,
      inp_p75_ms: inpEntry?.inp_p75_ms ?? null,
      lcpStatus: lcpEntry?.lcp_p75_ms != null
        ? lcpEntry.lcp_p75_ms <= 2500 ? "good"
          : lcpEntry.lcp_p75_ms <= 4000 ? "needs_improvement" : "poor"
        : null,
      clsStatus: clsEntry?.p75_cls != null
        ? clsEntry.p75_cls <= 0.1 ? "good"
          : clsEntry.p75_cls <= 0.25 ? "needs_improvement" : "poor"
        : null,
      inpStatus: inpEntry?.inp_p75_ms != null
        ? inpEntry.inp_p75_ms <= 200 ? "good"
          : inpEntry.inp_p75_ms <= 500 ? "needs_improvement" : "poor"
        : null,
      // Crawler-exclusive fields — null until Stage 2 fills them
      ctaText: null,
      ctaAboveFoldDesktop: null,
      ctaAboveFoldMobile: null,
      hasSocialProof: null,
      scrollDepth: null,
      screenshotUrl: null,
      mobileScreenshotUrl: null,
      crawlerEnriched: false,
    };
  });

  // Traffic sources — group by lowercased primary token so "Google",
  // "google", "google.com / organic" collapse into one row.
  const trafficByGroup = new Map();
  for (const row of (trafficSources || [])) {
    const key = normalizeSource(row.referrer_source);
    const sessions = toCount(row.sessions);
    const cr = toRate(row.conversion_rate);
    const br = toRate(row.bounce_rate);
    const g = trafficByGroup.get(key);
    if (!g) {
      trafficByGroup.set(key, {
        source: key,
        sessions,
        crWeighted: cr != null ? cr * sessions : 0,
        brWeighted: br != null ? br * sessions : 0,
        crWeight: cr != null ? sessions : 0,
        brWeight: br != null ? sessions : 0,
      });
    } else {
      g.sessions += sessions;
      if (cr != null) { g.crWeighted += cr * sessions; g.crWeight += sessions; }
      if (br != null) { g.brWeighted += br * sessions; g.brWeight += sessions; }
    }
  }
  const trafficNormalized = [...trafficByGroup.values()].map((g) => ({
    source: g.source,
    sessions: g.sessions,
    conversionRate: g.crWeight ? round4(g.crWeighted / g.crWeight) : null,
    bounceRate: g.brWeight ? round4(g.brWeighted / g.brWeight) : null,
  }));

  // Devices — ONLY sessions and online_store_visitors are real per device.
  // bounce_rate and conversion_rate are NOT available from ShopifyQL's
  // session_device_type grouping — confirmed from Shopify Explore UI.
  const totalDeviceSessions = sumField(devices, "sessions");
  const devicesNormalized = {};
  for (const row of (devices || [])) {
    devicesNormalized[row.session_device_type] = {
      sessions: toCount(row.sessions),
      onlineStoreVisitors: toCount(row.online_store_visitors),
      percentage: totalDeviceSessions
        ? round4(toCount(row.sessions) / totalDeviceSessions)
        : 0,
      conversionRate: null,
      bounceRate: null,
      requiresAdditionalQuery: true,
    };
  }

  // Honor the extractor's declared period if present; fall back to "7d".
  const period =
    rawExtraction.metrics?.period ||
    rawExtraction.metrics?.window ||
    "7d";

  return {
    period,
    fetchedAt: new Date().toISOString(),
    dataSource: "shopify",
    websiteUrl: rawExtraction.websiteUrl || null,
    overview: {
      totalSessions,
      totalRevenue: round2(totalSales),
      totalOrders,
      avgOrderValue: round2(avgOrderValue),
      conversionRate: round4(overallConversionRate),
      bounceRate: round4(overallBounceRate),
      cartAbandonmentRate,
      // avgPageLoadTime intentionally omitted — no single ShopifyQL field
      // provides it; use pages[].lcp_p75_ms instead.
    },
    dailyOverview: overviewRows
      .filter((r) => r.day && r.day !== "total")
      .map((r) => ({
        day: r.day,
        sessions: toCount(r.sessions),
        conversionRate: round4(toRate(r.conversion_rate)),
        bounceRate: round4(toRate(r.bounce_rate)),
      })),
    dailySales: sales.map((r) => ({
      day: r.day,
      sales: round2(toCount(r.total_sales)),
      orders: toCount(r.orders),
      aov: round2(toCount(r.average_order_value)),
    })),
    funnel: funnelNormalized,
    traffic: trafficNormalized,
    devices: devicesNormalized,
    pages: pagesNormalized,
  };
}

module.exports = { normalize };
