/**
 * detector.js
 *
 * Inspects a council portal URL and returns the software platform name.
 * The platform name maps to an adapter in src/adapters/.
 *
 * Supported platforms:
 *   idox      — PublicAccess, used by ~200+ UK councils.
 *               publicaccess.*, online-applications.*, pa.*, idoxpa-*, /Search/Advanced/ (Idox cloud)
 *   arcus     — Agile Applications "Citizen Portal" SPA + JSON API.
 *               planning.agileapplications.co.uk/{council}/...
 *   northgate — Northgate / Planning Explorer (ASP.NET).
 *               Northgate/PlanningExplorer/..., planning/index.html?fa=search, planning/search-all
 *   socrata   — Open-data JSON API (e.g. Camden). opendata.*, /about_data
 *
 * If unrecognised, returns 'unknown'. No adapter will run for 'unknown'.
 *
 * NOTE: Milton Keynes uses a Salesforce-hosted "Arcus BE" register
 *   (www.be.milton-keynes.gov.uk/pr/s/...). That is NOT the agileapplications
 *   citizen portal and is intentionally treated as 'unknown' here.
 */

function detectPlatform(url) {
  if (!url) return 'unknown';

  const lower = url.toLowerCase();

  // ── Arcus / Agile Applications ───────────────────────────────────────────
  // Check before Idox: distinctive host, and the Salesforce "Arcus BE" variant
  // (/pr/s/ on a council domain) must be excluded — it's a different platform.
  if (lower.includes('agileapplications.co.uk')) {
    return 'arcus';
  }

  // ── Northgate / Planning Explorer ────────────────────────────────────────
  if (
    lower.includes('northgate') ||
    lower.includes('planningexplorer') ||
    lower.includes('/planning/index.html') ||
    lower.includes('/planning/search-all')
  ) {
    return 'northgate';
  }

  // ── Socrata open data (e.g. Camden) ──────────────────────────────────────
  if (lower.includes('opendata.') || lower.includes('/about_data')) {
    return 'socrata';
  }

  // ── Salesforce-based registers (Arcus BE / similar) ──────────────────────
  // These can sit on publicaccess.* or publicregister.* hostnames but are NOT
  // classic Idox. Tell-tale path: /s/detail/, /s/register-view, /pr/s/.
  // We don't have a fetcher for this platform, so classify distinctly (skipped).
  if (
    lower.includes('/s/detail/') ||
    lower.includes('/s/register-view') ||
    lower.includes('/pr/s/') ||
    lower.includes('arcus_be_public_register')
  ) {
    return 'salesforce'; // no adapter yet — routed but skipped
  }

  // ── Idox / PublicAccess (incl. variants) ─────────────────────────────────
  // The RELIABLE Idox signal is the path applicationDetails.do?...keyVal= ,
  // NOT just a "publicaccess" hostname (some publicaccess hosts are Salesforce,
  // already excluded above). Hostname hints are kept as secondary signals.
  if (
    lower.includes('applicationdetails.do') || // primary, reliable Idox signal
    lower.includes('online-applications') ||
    lower.includes('newplanningaccess') ||
    lower.includes('idoxpa') ||
    lower.includes('publicaccess') ||
    lower.includes('/pa.') ||
    lower.includes('planningapplications') ||
    /\/search\/advanced\/?/.test(lower) // Idox cloud (Worcester, Leicester)
  ) {
    return 'idox';
  }

  // ── Future platforms (commented out until adapters exist) ────────────────
  // if (lower.includes('uniform.net')) return 'uniform';
  // if (lower.includes('acolaid'))     return 'acolaid';

  return 'unknown';
}

module.exports = { detectPlatform };