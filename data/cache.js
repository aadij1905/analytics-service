const store = {};
const crawlStatuses = {};

function hasData(storeId) { return Object.prototype.hasOwnProperty.call(store, storeId); }
function getData(storeId) { return store[storeId] || null; }
function setData(storeId, normalized, flags, rawExtraction, meta = {}) {
  store[storeId] = {
    normalized,
    flags,
    rawExtraction,
    ingestedAt: new Date().toISOString(),
    crawlerRan: meta.crawlerRan || false,
  };
}
function setCrawlStatus(storeId, status) { crawlStatuses[storeId] = status; }
function getCrawlStatus(storeId) { return crawlStatuses[storeId] || null; }
function listStores() { return Object.keys(store); }

module.exports = { hasData, getData, setData, setCrawlStatus, getCrawlStatus, listStores };
