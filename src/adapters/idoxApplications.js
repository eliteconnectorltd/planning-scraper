'use strict';

const { classifyChallenge } = require('../browserChallenges');

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function canonicalizeUrl(rawUrl, baseUrl) {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl, baseUrl).href;
  } catch {
    return null;
  }
}

function getPortalBase(url) {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^(.*?\/(?:online-applications|publicaccess|planningapplications))(?:\/|$)/i);
  if (match) return `${parsed.origin}${match[1]}`;
  return parsed.origin;
}

function buildSearchCandidates(sourceUrl) {
  const base = getPortalBase(sourceUrl);
  return Array.from(new Set([
    `${base}/search.do?action=weeklyList`,
    `${base}/search.do?action=simple&searchType=Application`,
    `${base}/search.do?action=advanced`,
    sourceUrl,
  ]));
}

function deriveDocumentsUrl(summaryUrl) {
  if (!summaryUrl) return null;
  return summaryUrl.includes('activeTab=')
    ? summaryUrl.replace(/activeTab=[^&]+/i, 'activeTab=documents')
    : `${summaryUrl}${summaryUrl.includes('?') ? '&' : '?'}activeTab=documents`;
}

function extractReferenceFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('keyVal') || parsed.searchParams.get('applicationNumber') || null;
  } catch {
    return null;
  }
}

async function navigateWithRetry(page, url, timeout) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      await page.waitForTimeout(1500);
      return true;
    } catch (err) {
      lastError = err;
      console.log(`[EXTRACT] Navigation attempt ${attempt} failed: ${err.message}`);
      await page.waitForTimeout(1000 * attempt).catch(() => {});
    }
  }
  throw lastError;
}

async function trySubmitSearch(page) {
  if (/action=weeklyList/i.test(page.url())) return;

  const submitted = await page.evaluate((searchDays) => {
    const pad = value => String(value).padStart(2, '0');
    const formatDate = date => `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
    const end = new Date();
    const start = new Date(Date.now() - (Number(searchDays) || 14) * 24 * 60 * 60 * 1000);
    const startValue = formatDate(start);
    const endValue = formatDate(end);

    const setInput = (selectors, value) => {
      for (const selector of selectors) {
        const input = document.querySelector(selector);
        if (input) {
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    };

    setInput([
      'input[name="date(applicationValidatedStart)"]',
      'input#applicationValidatedStart',
      'input[name="date(applicationReceivedStart)"]',
      'input#applicationReceivedStart',
    ], startValue);
    setInput([
      'input[name="date(applicationValidatedEnd)"]',
      'input#applicationValidatedEnd',
      'input[name="date(applicationReceivedEnd)"]',
      'input#applicationReceivedEnd',
    ], endValue);

    const forms = Array.from(document.querySelectorAll('form'));
    const searchForm = forms.find(form => /search/i.test(form.action || '') || /search/i.test(form.innerText || ''));
    if (!searchForm) return false;
    const buttons = Array.from(searchForm.querySelectorAll('button, input[type="submit"], input[type="button"]'));
    const button = buttons.find(el => /search|submit/i.test(el.value || el.textContent || el.getAttribute('title') || ''));
    if (!button) return false;
    button.click();
    return true;
  }, Number(process.env.LOCATION_SEARCH_DAYS) || 14).catch(() => false);

  if (submitted) {
    await Promise.race([
      page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {}),
      page.waitForURL(url => /search\.do/i.test(url.href), { timeout: 10000 }).catch(() => {}),
      page.waitForTimeout(5000),
    ]);
    await page.waitForTimeout(2000).catch(() => {});
  }
}

async function extractApplicationsFromPage(page, sourceUrl, location, maxApplications) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await Promise.race([
        page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}),
        page.waitForTimeout(1500),
      ]);
      return await page.evaluate(({ sourceUrl: baseUrl, location, maxApplications }) => {
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const absolute = raw => {
      try { return new URL(raw, baseUrl).href; } catch { return null; }
    };
    const docsUrl = summaryUrl => summaryUrl.includes('activeTab=')
      ? summaryUrl.replace(/activeTab=[^&]+/i, 'activeTab=documents')
      : `${summaryUrl}${summaryUrl.includes('?') ? '&' : '?'}activeTab=documents`;
    const refFromUrl = url => {
      try {
        const parsed = new URL(url);
        return parsed.searchParams.get('keyVal') || parsed.searchParams.get('applicationNumber') || null;
      } catch {
        return null;
      }
    };

    const anchors = Array.from(document.querySelectorAll('a[href*="applicationDetails.do"], a[href*="activeTab=summary"]'));
    const seen = new Set();
    const applications = [];

    for (const anchor of anchors) {
      const href = absolute(anchor.getAttribute('href'));
      if (!href || seen.has(href)) continue;
      seen.add(href);

      const row = anchor.closest('tr, li, article, div.searchResult, div.application, div');
      const rowText = normalize(row ? row.innerText : anchor.textContent);
      const cells = row ? Array.from(row.querySelectorAll('td, li, dd, span')).map(cell => normalize(cell.innerText)).filter(Boolean) : [];
      const refMatch = rowText.match(/\bRef\.?\s*No\.?:?\s*([A-Za-z0-9/_.-]+)/i)
        || rowText.match(/\bReference\s*:?\s*([A-Za-z0-9/_.-]+)/i);
      const reference = refMatch
        ? refMatch[1]
        : (refFromUrl(href) || normalize(anchor.textContent) || cells.find(text => /\d/.test(text)) || href);

      const statusMatch = rowText.match(/\b(?:Status|Decision)\s*:?\s*([A-Za-z][A-Za-z\s-]{2,40})/i);
      const receivedMatch = rowText.match(/\b(?:Received|Validated|Date Received)\s*:?\s*((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\s*\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2})/i);
      const proposal = normalize((rowText.split(/\bRef\.?\s*No\.?:?/i)[0] || '').replace(/Show more description/ig, '')) ||
        cells.find(text => text.length > 30 && !text.includes(reference)) ||
        rowText;
      const address = cells.find(text => /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(text)) || '';

      applications.push({
        application_uid: reference,
        application_reference: reference,
        council_name: location.postcode || location.region || '',
        address,
        proposal,
        status: statusMatch ? statusMatch[1].trim() : null,
        source_url: href,
        documents_url: docsUrl(href),
        received_date: receivedMatch ? receivedMatch[1] : null,
      });

      if (applications.length >= maxApplications) break;
    }

    return applications;
      }, { sourceUrl, location, maxApplications });
    } catch (err) {
      if (!/Execution context was destroyed|navigation/i.test(err.message || '') || attempt === 3) {
        throw err;
      }
      console.log(`[EXTRACT] Page still navigating during extraction; retrying (${attempt}/3)`);
      await page.waitForTimeout(1500).catch(() => {});
    }
  }

  return [];
}

async function extractApplicationSummary(page, summaryUrl) {
  await navigateWithRetry(page, summaryUrl, Number(process.env.LOCATION_EXTRACTION_TIMEOUT_MS) || 30000);

  return page.evaluate(() => {
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const bodyText = normalize(document.body.innerText || '');
    const findDate = (label) => {
      const pattern = new RegExp(`${label}\\s*:?[\\s\\n]*((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\\s*\\d{1,2}\\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\s+\\d{4}|\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2})`, 'i');
      const match = bodyText.match(pattern);
      return match ? normalize(match[1]) : null;
    };
    const pairValue = (labels) => {
      const terms = Array.from(document.querySelectorAll('dt, th, label'));
      for (const term of terms) {
        const label = normalize(term.textContent).toLowerCase();
        if (!labels.some(value => label.includes(value))) continue;
        const valueEl = term.nextElementSibling;
        if (valueEl) {
          const value = normalize(valueEl.textContent);
          if (value) return value;
        }
      }
      return null;
    };

    const reference = pairValue(['reference', 'application number'])
      || bodyText.match(/\b\d{2}\/[A-Za-z0-9/_.-]+\b/)?.[0]
      || null;
    const proposal = pairValue(['proposal', 'development description', 'description'])
      || document.querySelector('.description, #description, [class*="proposal"]')?.textContent
      || null;
    const address = pairValue(['address', 'location'])
      || document.querySelector('.address, #address, [class*="address"]')?.textContent
      || null;
    const status = pairValue(['status', 'decision'])
      || bodyText.match(/\b(?:Status|Decision)\s*:?\s*([A-Za-z][A-Za-z\s-]{2,40})/i)?.[1]
      || null;

    return {
      application_reference: reference ? normalize(reference) : null,
      proposal: proposal ? normalize(proposal) : null,
      address: address ? normalize(address) : null,
      status: status ? normalize(status) : null,
      received_date: findDate('Received|Date Received') || null,
      validated_date: findDate('Validated|Date Validated') || null,
    };
  });
}

async function scrapeIdoxApplications(page, sourceUrl, location, maxApplications = 5, options = {}) {
  const timeout = options.timeout || Number(process.env.LOCATION_EXTRACTION_TIMEOUT_MS) || Math.min(Number(process.env.TIMEOUT) || 45000, 20000);
  const candidates = buildSearchCandidates(sourceUrl);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      console.log(`[EXTRACT] Trying IDOX application search: ${candidate}`);
      await navigateWithRetry(page, candidate, timeout);

      const challenge = await classifyChallenge(page, new URL(candidate).hostname).catch(() => ({ blocked: false }));
      if (challenge.blocked) {
        const err = new Error(`Portal blocked by managed challenge: ${challenge.reason || 'unknown challenge'}`);
        err.code = 'BLOCKED';
        throw err;
      }

      await trySubmitSearch(page);
      const applications = await extractApplicationsFromPage(page, page.url(), location, maxApplications);
      if (applications.length > 0) {
        const enriched = [];
        for (const app of applications) {
          const summaryUrl = canonicalizeUrl(app.source_url, page.url());
          let summary = {};
          try {
            summary = summaryUrl ? await extractApplicationSummary(page, summaryUrl) : {};
          } catch (err) {
            console.log(`[EXTRACT] Summary enrichment failed for ${app.application_reference}: ${err.message}`);
          }
          enriched.push({ ...app, ...Object.fromEntries(Object.entries(summary).filter(([, value]) => value)) });
        }

        return {
          applications: enriched.map(app => ({
            application_uid: app.application_uid,
            application_reference: app.application_reference,
            council_name: app.council_name,
            address: app.address,
            proposal: app.proposal,
            status: app.status,
            source_url: canonicalizeUrl(app.source_url, page.url()),
            documents_url: deriveDocumentsUrl(canonicalizeUrl(app.source_url, page.url())),
            received_date: app.received_date,
            validated_date: app.validated_date,
          })),
          sourceUrl: candidate,
        };
      }
    } catch (err) {
      lastError = err;
      console.log(`[EXTRACT] Candidate failed: ${err.message}`);
    }
  }

  if (lastError) throw lastError;
  return { applications: [], sourceUrl };
}

module.exports = {
  buildSearchCandidates,
  deriveDocumentsUrl,
  scrapeIdoxApplications,
  extractReferenceFromUrl,
};
