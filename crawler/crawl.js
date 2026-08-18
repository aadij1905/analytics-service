const { chromium } = require("playwright");
const { saveScreenshot } = require("./screenshotStorage");

const CTA_SELECTORS = [
  "[data-testid='add-to-cart']",
  ".product-form__submit",
  "button[name='add']",
  ".btn--add-to-cart",
  "input[name='add']",
];

const SOCIAL_PROOF_SELECTORS = [
  ".product-reviews",
  "[data-testid='product-reviews']",
  ".stamped-reviews",
  ".yotpo",
  ".trustpilot-widget",
  ".review-count",
  ".star-rating",
];

// Text patterns for the theme-agnostic CTA fallback — matched against a
// button/link/submit's visible text when none of the CSS selectors above hit
// (non-Dawn themes name their buttons differently but the wording is stable).
const CTA_TEXT_PATTERN = "add to cart|add to bag|add to basket|buy now|buy it now|pre-?order";

const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const MOBILE_VIEWPORT  = { width: 390,  height: 844 };
const USER_AGENT = "Mozilla/5.0 (compatible; EXP-Intelligence-Crawler/1.0)";

// A page is "ready enough" to inspect once its primary CTA or a price is in
// the DOM — waiting on one of these (with a short cap) beats a blind fixed
// delay that's too short for app-heavy stores and wasted on fast ones.
const READINESS_SELECTOR = [...CTA_SELECTORS, ".price", "[class*='price']", "[data-price]"].join(",");

// Finds the add-to-cart control: known theme selectors first, then a text
// heuristic across buttons/submits/links so non-Dawn themes aren't silently
// under-detected. Returns an ElementHandle or null.
async function findCtaHandle(page) {
  for (const sel of CTA_SELECTORS) {
    const el = await page.$(sel);
    if (el) return el;
  }
  const handle = await page.evaluateHandle((pattern) => {
    const re = new RegExp(pattern, "i");
    const els = [...document.querySelectorAll("button, input[type=submit], input[type=button], a[role=button], a")];
    for (const el of els) {
      const txt = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
      if (txt && re.test(txt)) return el;
    }
    return null;
  }, CTA_TEXT_PATTERN);
  return handle.asElement(); // null if the heuristic found nothing
}

// True if the page shows any review/rating signal — known widget selectors
// first, then generic star/rating/"N reviews" heuristics for other themes.
async function detectSocialProof(page) {
  for (const sel of SOCIAL_PROOF_SELECTORS) {
    if (await page.$(sel)) return true;
  }
  return page.evaluate(() => {
    if (document.querySelector("[class*='star' i], [class*='rating' i], [aria-label*='star' i], [aria-label*='rating' i]")) {
      return true;
    }
    const text = (document.body && document.body.innerText) || "";
    return /★|⭐/.test(text)
      || /\b\d+(\.\d+)?\s*(?:out of|\/)\s*5\b/i.test(text)   // "4.5 out of 5", "4.5/5"
      || /\b\d+\s+reviews?\b/i.test(text);                    // "128 reviews"
  });
}

// Reusable browser session. Previously we booted a full Chromium per page —
// ~1s of overhead × 8 pages was wasted. Now callers open a session once and
// hand each page's URL to session.visit().
async function openSession() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: DESKTOP_VIEWPORT,
    userAgent: USER_AGENT,
  });

  async function visit(pageUrl, outputDir) {
    const page = await context.newPage();
    try {
      // "networkidle" hangs indefinitely on real storefronts with persistent
      // background chatter (chat widgets, review-app polling, analytics
      // beacons) — it waits for ALL network activity to stop, which many
      // Shopify apps never let happen. "load" plus a short fixed settle
      // delay is far more reliable: it waits for the page itself to finish
      // loading, then gives app-injected DOM (CTAs, review widgets) a beat
      // to render without waiting on background traffic that never quiets.
      await page.goto(pageUrl, { waitUntil: "load", timeout: 30000 });
      // Wait for the CTA/price to render (app-injected DOM often lands after
      // "load"), capped short; fall back to a brief settle if it never shows.
      await page.waitForSelector(READINESS_SELECTOR, { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(400);

      // Every visit — not just the initial unlock — checks for the password
      // wall. The unlock cookie can fail to apply to a given request, expire
      // mid-crawl, or unlock() can have false-positived success; trusting
      // "we unlocked once" for the rest of the session silently turns wall
      // screenshots into fake "real" data. Shopify redirects ANY blocked
      // route to /password, so a URL check here is exact, not a guess.
      if (page.url().includes("/password")) {
        return {
          ctaText: null,
          ctaAboveFoldDesktop: null,
          ctaAboveFoldMobile: null,
          hasSocialProof: false,
          scrollDepth: null,
          screenshotUrl: null,
          mobileScreenshotUrl: null,
          crawlerBlocked: true,
        };
      }

      // CTA detection (theme selectors, then a text heuristic — see findCtaHandle)
      let ctaText = null;
      let ctaAboveFoldDesktop = null;
      let ctaAboveFoldMobile = null;

      const ctaEl = await findCtaHandle(page);
      if (ctaEl) {
        const raw = await ctaEl.textContent().then((t) => t?.trim() || null);
        ctaText = raw
          || (await ctaEl.evaluate((n) => (n.value || n.getAttribute("aria-label") || "").trim() || null).catch(() => null));
        const box = await ctaEl.boundingBox();
        if (box) {
          ctaAboveFoldDesktop = box.y < DESKTOP_VIEWPORT.height;
          await page.setViewportSize(MOBILE_VIEWPORT);
          const mobileBox = await ctaEl.boundingBox();
          ctaAboveFoldMobile = mobileBox ? mobileBox.y < MOBILE_VIEWPORT.height : null;
          await page.setViewportSize(DESKTOP_VIEWPORT);
        }
      }

      // Social proof detection (theme selectors, then generic heuristics)
      const hasSocialProof = await detectSocialProof(page);

      // Scroll-depth estimate: how much of the page fits in a desktop viewport.
      const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
      const scrollDepth = scrollHeight > 0
        ? Math.min(1, DESKTOP_VIEWPORT.height / scrollHeight)
        : null;

      // Screenshots — one per viewport, sharing a timestamp so the two
      // files for a page are easy to pair up. saveScreenshot() uploads to
      // R2 when configured, otherwise falls back to outputDir on local disk.
      let screenshotUrl = null;
      let mobileScreenshotUrl = null;

      if (outputDir) {
        const ts = Date.now();
        const desktopBuffer = await page.screenshot({ type: "jpeg", quality: 80 });
        screenshotUrl = await saveScreenshot(desktopBuffer, `${ts}-desktop.jpg`, outputDir);

        await page.setViewportSize(MOBILE_VIEWPORT);
        const mobileBuffer = await page.screenshot({ type: "jpeg", quality: 80 });
        mobileScreenshotUrl = await saveScreenshot(mobileBuffer, `${ts}-mobile.jpg`, outputDir);
        await page.setViewportSize(DESKTOP_VIEWPORT);
      }

      return {
        ctaText,
        ctaAboveFoldDesktop,
        ctaAboveFoldMobile,
        hasSocialProof,
        scrollDepth,
        screenshotUrl,
        mobileScreenshotUrl,
        crawlerBlocked: false,
      };
    } finally {
      await page.close();
    }
  }

  // Password-protected storefronts (pre-launch / dev stores) gate every
  // route behind Shopify's standard /password page. Submitting the form
  // once sets a cookie on `context`, so subsequent visit() calls in this
  // same session reach real pages instead of the password wall.
  // Three-state return — callers need to tell "nothing to do" apart from
  // "we tried and failed", since only the latter should abort the crawl:
  //   null  — no password wall found; store isn't password-protected
  //   true  — wall found and unlocked
  //   false — wall found, unlock failed after retries
  async function unlock(baseUrl, password) {
    const page = await context.newPage();
    let hasPasswordWall;
    try {
      await page.goto(`${baseUrl}/password`, { waitUntil: "load", timeout: 30000 });
      hasPasswordWall = (await page.$('input[type="password"]')) !== null;
    } catch (err) {
      console.error(`Storefront unlock check failed for ${baseUrl}:`, err.message);
      await page.close();
      return false;
    }
    if (!hasPasswordWall) {
      await page.close();
      return null; // store isn't password-protected — nothing to do
    }

    // Up to 2 attempts — a single miss is often a transient redirect/timing
    // race, not a wrong password, so one retry avoids wasting an otherwise
    // successful crawl over a fluke.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const input = await page.$('input[type="password"]');
        await input.fill(password);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "load", timeout: 30000 }).catch(() => {}),
          input.press("Enter"),
        ]);
      } catch (err) {
        console.error(`Unlock submit attempt ${attempt} failed for ${baseUrl}:`, err.message);
      }

      // Verify against the actual target, not the password page's own
      // post-submit state — this is exactly what every later visit() call
      // will experience, so it's the only check that can't false-positive.
      try {
        await page.goto(baseUrl, { waitUntil: "load", timeout: 30000 });
        if (!page.url().includes("/password")) {
          await page.close();
          return true;
        }
      } catch (err) {
        console.error(`Unlock verification attempt ${attempt} failed for ${baseUrl}:`, err.message);
      }

      if (attempt < 2) {
        await page.goto(`${baseUrl}/password`, { waitUntil: "load", timeout: 30000 }).catch(() => {});
      }
    }

    await page.close();
    return false;
  }

  async function close() {
    await context.close();
    await browser.close();
  }

  return { visit, unlock, close };
}

module.exports = { openSession };
