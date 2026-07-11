const { chromium } = require("playwright");

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
      await page.goto(pageUrl, { waitUntil: "networkidle", timeout: 30000 });

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

      // Screenshot
      const screenshotPath = outputDir
        ? `${outputDir}/${Date.now()}.jpg`
        : null;
      if (screenshotPath) {
        await page.screenshot({ path: screenshotPath, type: "jpeg", quality: 80 });
      }

      return {
        ctaText,
        ctaAboveFoldDesktop,
        ctaAboveFoldMobile,
        hasSocialProof,
        scrollDepth,
        screenshotPath,
      };
    } finally {
      await page.close();
    }
  }

  async function close() {
    await context.close();
    await browser.close();
  }

  return { visit, close };
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
