'use strict';

const fs = require('fs');
const path = require('path');

const CHALLENGE_PATTERNS = [
  /verify\s+you\s+are\s+human/i,
  /checking\s+your\s+browser/i,
  /cf-browser-verification/i,
  /turnstile/i,
  /managed\s+challenge/i,
  /cf-challenge/i,
  /cloudflare/i,
];

async function detectChallenge(page) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const bodyText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  const html = await page.content().catch(() => '');
  const sample = `${url}\n${title}\n${bodyText}\n${html.slice(0, 5000)}`;
  const matchedPattern = CHALLENGE_PATTERNS.find(pattern => pattern.test(sample));
  return {
    blocked: Boolean(matchedPattern),
    reason: matchedPattern ? matchedPattern.source : null,
    url,
    title,
  };
}

async function captureChallengeDiagnostics(page, label = 'challenge') {
  const debugDir = path.join(__dirname, '..', 'debug');
  fs.mkdirSync(debugDir, { recursive: true });
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_');
  const stamp = Date.now();
  const htmlPath = path.join(debugDir, `${safeLabel}_${stamp}.html`);
  const pngPath = path.join(debugDir, `${safeLabel}_${stamp}.png`);
  const statePath = path.join(debugDir, `${safeLabel}_${stamp}_storage.json`);

  await fs.promises.writeFile(htmlPath, await page.content(), 'utf8').catch(() => {});
  await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {});
  await page.context().storageState({ path: statePath }).catch(() => {});

  return { htmlPath, pngPath, statePath };
}

async function classifyChallenge(page, label) {
  const detection = await detectChallenge(page);
  if (!detection.blocked) return detection;
  const diagnostics = await captureChallengeDiagnostics(page, label || 'cloudflare_challenge');
  return { ...detection, diagnostics, status: 'BLOCKED' };
}

module.exports = {
  CHALLENGE_PATTERNS,
  detectChallenge,
  captureChallengeDiagnostics,
  classifyChallenge,
};
