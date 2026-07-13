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

const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const MOBILE_VIEWPORT  = { width: 390,  height: 844 };
const USER_AGENT = "Mozilla/5.0 (compatible; EXP-Intelligence-Crawler/1.0)";

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
      await page.waitForTimeout(1000);

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

      // CTA detection
      let ctaText = null;
      let ctaAboveFoldDesktop = null;
      let ctaAboveFoldMobile = null;

      for (const sel of CTA_SELECTORS) {
        const el = await page.$(sel);
        if (!el) continue;
        ctaText = await el.textContent().then((t) => t?.trim() || null);
        const box = await el.boundingBox();
        if (box) {
          ctaAboveFoldDesktop = box.y < DESKTOP_VIEWPORT.height;
          await page.setViewportSize(MOBILE_VIEWPORT);
          const mobileBox = await el.boundingBox();
          ctaAboveFoldMobile = mobileBox ? mobileBox.y < MOBILE_VIEWPORT.height : null;
          await page.setViewportSize(DESKTOP_VIEWPORT);
        }
        break;
      }

      // Social proof detection
      let hasSocialProof = false;
      for (const sel of SOCIAL_PROOF_SELECTORS) {
        const el = await page.$(sel);
        if (el) { hasSocialProof = true; break; }
      }

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

// Backwards-compatible one-shot API — kept for callers/tests that only crawl
// a single page.
async function crawlPage(pageUrl, outputDir) {
  const session = await openSession();
  try {
    return await session.visit(pageUrl, outputDir);
  } finally {
    await session.close();
  }
}

module.exports = { crawlPage, openSession };
