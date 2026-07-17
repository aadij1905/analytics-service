# Analytics Service

Normalizes raw ShopifyQL data from `shopify-pp`, detects issues (bounce/CWV/
cart-abandonment flags), and crawls the storefront with Playwright to capture
screenshots + layout signals (CTA position, social proof, scroll depth). Serves
all of it to `ai service 2` for suggestion generation.

Part of the larger pipeline — see the [root README](../README.md) for how this
fits with `shopify-pp`, `ai service 2`, and `review-hub`.

## Run

```bash
npm install
cp .env.example .env   # defaults work as-is for local dev, see below
npm run dev             # http://localhost:4000, auto-restarts (nodemon)
# or: npm start          # no auto-restart
```

Playwright needs its Chromium binary installed once:

```bash
npx playwright install chromium
```

No env vars are required to run locally — `.env.example` documents the
optional ones:

| Var | Required? | Purpose |
| --- | --- | --- |
| `PORT` | no (defaults 4000) | HTTP port |
| `PUBLIC_URL` | no (defaults `http://localhost:4000`) | Base URL screenshots are served from when R2 isn't configured (local-disk fallback) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL` | no | Cloudflare R2 (S3-compatible) screenshot storage. All five must be set together or the crawler silently falls back to local disk — see `crawler/screenshotStorage.js`. Local disk is fine for dev; use R2 in production (Railway's filesystem is ephemeral) |

## How it works

```
POST /api/analytics/ingest
  → normalize()        raw ShopifyQL rows → normalized.pages/overview/traffic/...
  → detectAll()         normalized data → flags (bounce, CWV, cart abandonment, ...)
  → respond immediately (don't block on the crawl)
  → runCrawler()         [async, if websiteUrl was given] Playwright visits top
                          pages, captures desktop+mobile screenshots, CTA
                          position, social proof, scroll depth
  → re-run detectAll() once the crawl finishes, cache the enriched result
```

Everything is cached in-memory per `storeId` (`data/cache.js`) — no database,
resets on restart. `GET /api/analytics/*` endpoints fall back to generated
mock data if a `storeId` has never been ingested, so the service is demoable
standalone.

Full endpoint reference (ingest, status, report, and section endpoints) is in
[`../TESTING.md`](../TESTING.md).

## Gotcha: crawl runs asynchronously

`POST /api/analytics/ingest` returns as soon as ShopifyQL data is normalized —
the Playwright crawl (which can take from a few seconds to ~1-2 minutes
depending on page count) keeps running in the background. Poll
`GET /api/analytics/status?storeId=...` and wait for `crawlerStatus` to leave
`"running"` before calling `ai service 2`'s `/report/generate` — otherwise
you'll get a report generated from the pre-crawl snapshot (no screenshots, no
`layout[]` data). `review-hub` handles this via `waitForCrawl()` in
`src/lib/api.js`.

## Local end-to-end testing

See [`../TUNNELS.md`](../TUNNELS.md) for running this alongside `ai service 2`
and `review-hub` locally (with or without Cloudflare tunnels) and
[`../TESTING.md`](../TESTING.md) for a Postman-style endpoint walkthrough.
