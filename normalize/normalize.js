function toNumber(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function sumField(rows, field) { return rows.reduce((s, r) => s + toNumber(r[field]), 0); }
function avgWeighted(rows, valueField, weightField) {
  const totalWeight = sumField(rows, weightField);
  if (!totalWeight) return 0;
  return rows.reduce((s, r) => s + toNumber(r[valueField]) * toNumber(r[weightField]), 0) / totalWeight;
}
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

function normalize(rawExtraction) {
  const {
    overview: overviewRows,
    sales,
    pages,
    trafficSources,
    devices,
    funnelBreakdown,
    checkoutConversion,
    performanceLCP,
    performanceCLS,
    performanceINP,
  } = rawExtraction.raw;

  // Site-wide overview
  const totalSessions = sumField(overviewRows, "sessions");
  const totalSales = sumField(sales, "total_sales");
  const totalOrders = sumField(sales, "total_orders");
  const avgOrderValue = totalOrders ? totalSales / totalOrders : 0;
  const overallConversionRate = avgWeighted(overviewRows, "conversion_rate", "sessions");
  const overallBounceRate = avgWeighted(overviewRows, "bounce_rate", "sessions");

  // Cart abandonment derived from real checkout_conversion_rate.
  // Real data rows may not carry a sessions field — fall back to simple average.
  const avgCheckoutConversion = (() => {
    if (!checkoutConversion || !checkoutConversion.length) return null;
    const totalWeight = sumField(checkoutConversion, "sessions");
    if (totalWeight > 0) return avgWeighted(checkoutConversion, "checkout_conversion_rate", "sessions");
    const rates = checkoutConversion.map((r) => toNumber(r.checkout_conversion_rate)).filter((n) => n > 0);
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
  const funnelNormalized = {
    sessions: toNumber(funnelTotals.sessions) || totalSessions,
    sessionsWithCartAdditions: toNumber(funnelTotals.sessions_with_cart_additions),
    sessionsThatReachedCheckout: toNumber(funnelTotals.sessions_that_reached_checkout),
    sessionsThatCompletedCheckout: toNumber(funnelTotals.sessions_that_completed_checkout),
    conversionRate: round4(overallConversionRate),
    cartAdditionRate: totalSessions
      ? round4(toNumber(funnelTotals.sessions_with_cart_additions) / totalSessions)
      : null,
    checkoutReachRate: toNumber(funnelTotals.sessions_with_cart_additions)
      ? round4(
          toNumber(funnelTotals.sessions_that_reached_checkout) /
          toNumber(funnelTotals.sessions_with_cart_additions)
        )
      : null,
    checkoutCompletionRate: toNumber(funnelTotals.sessions_that_reached_checkout)
      ? round4(
          toNumber(funnelTotals.sessions_that_completed_checkout) /
          toNumber(funnelTotals.sessions_that_reached_checkout)
        )
      : null,
    dailyFunnel: funnelBreakdown
      .filter((r) => r.day && r.day !== "total")
      .map((r) => ({
        day: r.day,
        sessions: toNumber(r.sessions),
        cartAdditions: toNumber(r.sessions_with_cart_additions),
        reachedCheckout: toNumber(r.sessions_that_reached_checkout),
        completedCheckout: toNumber(r.sessions_that_completed_checkout),
      })),
  };

  // Performance lookup maps keyed by page_path (web_performance table)
  // page_path in web_performance matches landing_page_path value in sessions table
  const lcpByPath = {};
  for (const r of (performanceLCP || [])) {
    lcpByPath[r.page_path] = { lcp_p75_ms: toNumber(r.lcp_p75_ms), page_loads: toNumber(r.page_loads) };
  }
  const clsByPath = {};
  for (const r of (performanceCLS || [])) {
    clsByPath[r.page_path] = { p75_cls: toNumber(r.p75_cls), page_loads: toNumber(r.page_loads) };
  }
  const inpByPath = {};
  for (const r of (performanceINP || [])) {
    inpByPath[r.page_path] = { inp_p75_ms: toNumber(r.inp_p75_ms), page_loads: toNumber(r.page_loads) };
  }

  // Pages
  const pagesNormalized = pages.map((row) => {
    const path = row.landing_page_path;
    return {
      path,
      sessions: toNumber(row.sessions),
      conversionRate: round4(toNumber(row.conversion_rate)),
      bounceRate: round4(toNumber(row.bounce_rate)),
      lcp_p75_ms: lcpByPath[path]?.lcp_p75_ms ?? null,
      p75_cls: clsByPath[path]?.p75_cls ?? null,
      inp_p75_ms: inpByPath[path]?.inp_p75_ms ?? null,
      lcpStatus: lcpByPath[path]
        ? lcpByPath[path].lcp_p75_ms <= 2500 ? "good"
          : lcpByPath[path].lcp_p75_ms <= 4000 ? "needs_improvement" : "poor"
        : null,
      clsStatus: clsByPath[path]
        ? clsByPath[path].p75_cls <= 0.1 ? "good"
          : clsByPath[path].p75_cls <= 0.25 ? "needs_improvement" : "poor"
        : null,
      inpStatus: inpByPath[path]
        ? inpByPath[path].inp_p75_ms <= 200 ? "good"
          : inpByPath[path].inp_p75_ms <= 500 ? "needs_improvement" : "poor"
        : null,
      // Crawler-exclusive fields — null until Stage 2 fills them
      ctaText: null,
      ctaAboveFoldDesktop: null,
      ctaAboveFoldMobile: null,
      hasSocialProof: null,
      scrollDepth: null,
      screenshotPath: null,
      crawlerEnriched: false,
    };
  });

  // Traffic sources
  const trafficNormalized = trafficSources.map((row) => ({
    source: row.referrer_source,
    sessions: toNumber(row.sessions),
    conversionRate: round4(toNumber(row.conversion_rate)),
    bounceRate: round4(toNumber(row.bounce_rate)),
  }));

  // Devices — ONLY sessions and online_store_visitors are real per device.
  // bounce_rate and conversion_rate are NOT available from ShopifyQL's
  // session_device_type grouping — confirmed from Shopify Explore UI.
  const totalDeviceSessions = sumField(devices, "sessions");
  const devicesNormalized = {};
  for (const row of (devices || [])) {
    devicesNormalized[row.session_device_type] = {
      sessions: toNumber(row.sessions),
      onlineStoreVisitors: toNumber(row.online_store_visitors),
      percentage: totalDeviceSessions
        ? round4(toNumber(row.sessions) / totalDeviceSessions)
        : 0,
      conversionRate: null,
      bounceRate: null,
      avgPageLoadTime: null,
      requiresAdditionalQuery: true,
    };
  }

  return {
    period: "7d",
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
      avgPageLoadTime: null,
    },
    dailyOverview: overviewRows
      .filter((r) => r.day && r.day !== "total")
      .map((r) => ({
        day: r.day,
        sessions: toNumber(r.sessions),
        conversionRate: round4(toNumber(r.conversion_rate)),
        bounceRate: round4(toNumber(r.bounce_rate)),
      })),
    dailySales: sales.map((r) => ({
      day: r.day,
      sales: round2(toNumber(r.total_sales)),
      orders: toNumber(r.total_orders),
      aov: round2(toNumber(r.average_order_value)),
    })),
    funnel: funnelNormalized,
    traffic: trafficNormalized,
    devices: devicesNormalized,
    pages: pagesNormalized,
  };
}

module.exports = { normalize };
