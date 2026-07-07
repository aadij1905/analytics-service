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

async function crawlPage(pageUrl, outputDir) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (compatible; EXP-Intelligence-Crawler/1.0)",
  });
  const page = await context.newPage();

  try {
    await page.goto(pageUrl, { waitUntil: "networkidle", timeout: 30000 });

    // CTA detection
    let ctaText = null;
    let ctaAboveFoldDesktop = null;
    let ctaAboveFoldMobile = null;

    for (const sel of CTA_SELECTORS) {
      const el = await page.$(sel);
      if (el) {
        ctaText = await el.textContent().then((t) => t?.trim() || null);
        const box = await el.boundingBox();
        if (box) {
          ctaAboveFoldDesktop = box.y < 800;
          await page.setViewportSize({ width: 390, height: 844 });
          const mobileBox = await el.boundingBox();
          ctaAboveFoldMobile = mobileBox ? mobileBox.y < 844 : null;
          await page.setViewportSize({ width: 1280, height: 800 });
        }
        break;
      }
    }

    // Social proof detection
    let hasSocialProof = false;
    for (const sel of SOCIAL_PROOF_SELECTORS) {
      const el = await page.$(sel);
      if (el) { hasSocialProof = true; break; }
    }

    // Scroll depth estimate based on viewport vs full page height
    const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
    const scrollDepth = scrollHeight > 0
      ? Math.min(1, 800 / scrollHeight)
      : null;

    // Screenshot
    const screenshotPath = outputDir
      ? `${outputDir}/${Date.now()}.jpg`
      : null;
    if (screenshotPath) {
      await page.screenshot({ path: screenshotPath, type: "jpeg", quality: 80 });
    }

    return { ctaText, ctaAboveFoldDesktop, ctaAboveFoldMobile, hasSocialProof, scrollDepth, screenshotPath };
  } finally {
    await browser.close();
  }
}

module.exports = { crawlPage };
