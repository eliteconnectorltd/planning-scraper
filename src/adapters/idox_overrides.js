/**
 * adapters/idox_overrides.js
 *
 * Council-specific overrides for Idox portals.
 * Allows custom handling for councils with non-standard layouts, custom selectors,
 * or unique URL formats.
 *
 * Each override can specify:
 * - tabSelector: Custom selector to click the Documents tab
 * - tableSelector: Custom selector for the documents table
 * - customExtractor: An async function to extract documents if standard parsing fails
 * - customNormalizer: A function to modify the normalized document format
 */

const overrides = {
  // Example override for Camden council
  'camden.gov.uk': {
    tableSelector: '#customCamdenDocumentsTable',
    tabSelector: 'a:has-text("App Documents")'
  },
  
  // Example override for Newham council
  'newham.gov.uk': {
    // Newham is standard, but we can configure custom waits if it is exceptionally slow
    customWaitMs: 5000
  },

  // Example of a council that requires special URL parameter cleaning
  'uttlesford.gov.uk': {
    tabSelector: '#documents'
  }
};

/**
 * Retrieves the matching override configuration for a given URL.
 *
 * @param {string} url - The portal URL
 * @returns {object|null} - Matching override config or null
 */
function getOverrideForUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    
    // Match by subdomain or main domain segment
    for (const key of Object.keys(overrides)) {
      if (host.includes(key)) {
        console.log(`[idox-overrides] Found override rule for: ${key}`);
        return overrides[key];
      }
    }
  } catch (err) {
    console.log(`[idox-overrides] Error parsing URL for overrides: ${err.message}`);
  }
  return null;
}

module.exports = {
  getOverrideForUrl,
  overrides
};
