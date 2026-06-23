'use strict';

const fs = require('fs');
const path = require('path');
const { chromium: playwrightChromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
const { createTraceId } = require('./core/logger');

try {
  playwrightChromium.use(stealth());
} catch (err) {
  // Some plugin versions expose Puppeteer-only evasions. Playwright still runs safely without them.
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function randomViewport() {
  const widths = [1280, 1366, 1440, 1536, 1600];
  const heights = [720, 768, 864, 900, 960];
  return {
    width: pick(widths) + Math.floor(Math.random() * 25),
    height: pick(heights) + Math.floor(Math.random() * 25),
  };
}

function getSessionDir(sessionId = createTraceId('browser')) {
  const root = path.resolve(process.env.BROWSER_SESSION_DIR || path.join(__dirname, '..', '.sessions'));
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, sessionId.replace(/[^a-zA-Z0-9_-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function applyContextHardening(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function getParameter(parameter) {
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return originalGetParameter.call(this, parameter);
    };
  });
}

async function createHardenedPersistentContext(options = {}) {
  const sessionId = options.sessionId || createTraceId('browser');
  const userDataDir = options.userDataDir || getSessionDir(sessionId);
  const headless = options.headless ?? (process.env.HEADLESS === 'true');
  const context = await playwrightChromium.launchPersistentContext(userDataDir, {
    headless,
    slowMo: headless ? 0 : Number(process.env.HUMAN_SLOWMO_MS || 80),
    viewport: options.viewport || randomViewport(),
    userAgent: options.userAgent || pick(USER_AGENTS),
    locale: options.locale || process.env.BROWSER_LOCALE || 'en-GB',
    timezoneId: options.timezoneId || process.env.BROWSER_TIMEZONE || 'Europe/London',
    ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
  });
  await applyContextHardening(context);
  context.__sessionId = sessionId;
  return context;
}

async function createHardenedBrowser(options = {}) {
  const headless = options.headless ?? (process.env.HEADLESS === 'true');
  const browser = await playwrightChromium.launch({
    headless,
    slowMo: headless ? 0 : Number(process.env.HUMAN_SLOWMO_MS || 80),
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
  });
  return browser;
}

async function humanDelay(minMs = 250, maxMs = 900) {
  const ms = minMs + Math.floor(Math.random() * Math.max(maxMs - minMs, 1));
  await new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  USER_AGENTS,
  createHardenedBrowser,
  createHardenedPersistentContext,
  applyContextHardening,
  humanDelay,
  randomViewport,
};
