/**
 * browser.js
 *
 * Creates and returns a Playwright Chromium browser instance.
 * Used ONLY for scraping council portals (e.g., Idox).
 * Planit data is fetched via its JSON API without a browser.
 *
 * headless: false  → browser window is visible (easier to debug)
 * slowMo: 80       → slows down actions so you can watch what's happening
 *
 * To run in headless mode, set headless: true in .env or change here.
 */

const { createHardenedBrowser, createHardenedPersistentContext } = require('./browserHardening');

async function createBrowser() {
  const headless = process.env.HEADLESS === 'true';
  console.log(`[browser] Launching hardened Chromium (headless: ${headless})`);
  return createHardenedBrowser({ headless });
}

async function createBrowserContext(options = {}) {
  const headless = options.headless ?? (process.env.HEADLESS === 'true');
  console.log(`[browser] Launching hardened persistent context (headless: ${headless})`);
  return createHardenedPersistentContext({ ...options, headless });
}

module.exports = { createBrowser, createBrowserContext };
