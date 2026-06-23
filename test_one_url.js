/**
 * test_one_url.js  — place in project ROOT (same level as src/)
 *
 * Pushes ONE specific application URL through the real project chain:
 *   detectPlatform -> the matching adapter (idox/arcus/salesforce) -> downloadManager
 *
 * This isolates "does my integrated adapter + download work" from Planit's
 * location filter and from unreachable councils. Use a URL you've confirmed
 * loads in your browser from your current location.
 *
 * Usage:
 *   node test_one_url.js "<application URL>"
 *   node test_one_url.js "<url>" "<Council Name>"
 *
 * Examples (known reachable from India in earlier tests):
 *   Croydon  (idox):
 *     node test_one_url.js "https://publicaccess3.croydon.gov.uk/online-applications/applicationDetails.do?activeTab=documents&keyVal=TGTIIUJLG6I00" "Croydon"
 *   Haringey (salesforce):
 *     node test_one_url.js "https://publicregister.haringey.gov.uk/pr/s/planning-application/a0iP200000HoG4bIAF/hgy20261740?tabset-3892f=3" "Haringey"
 */

require('dotenv').config();

const { createBrowser } = require('./src/browser');
const { detectPlatform } = require('./src/detector');
const { scrapeIdoxDocuments } = require('./src/adapters/idox');
const { scrapeArcusDocuments } = require('./src/adapters/arcus');
const { scrapeSalesforceDocuments } = require('./src/adapters/salesforce');
const { downloadDocument } = require('./src/download/downloadManager');

const ADAPTERS = {
  idox: scrapeIdoxDocuments,
  arcus: scrapeArcusDocuments,
  salesforce: scrapeSalesforceDocuments,
};

async function main() {
  const url = process.argv[2];
  const council = process.argv[3] || 'TestCouncil';
  if (!url) {
    console.error('Usage: node test_one_url.js "<application URL>" ["<Council>"]');
    process.exit(1);
  }

  const platform = detectPlatform(url);
  console.log(`\n=== ONE-URL TEST ===`);
  console.log(`URL:      ${url}`);
  console.log(`Council:  ${council}`);
  console.log(`Platform: ${platform}\n`);

  const adapter = ADAPTERS[platform];
  if (!adapter) {
    console.error(`No adapter for platform "${platform}" — nothing to test.`);
    process.exit(1);
  }

  const browser = await createBrowser();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  if (process.env.TIMEOUT) page.setDefaultTimeout(Number(process.env.TIMEOUT));

  let docsObject = { documents: [], metrics: {} };
  try {
    docsObject = await adapter(page, url);
  } catch (e) {
    console.error(`Adapter threw: ${e.message} (code=${e.code || 'none'})`);
  }

  const documents = docsObject.documents || [];
  console.log(`\nAdapter found ${documents.length} document(s).`);
  documents.slice(0, 10).forEach((d, i) => console.log(`  ${i}. ${d.name}\n     ${d.url}`));

  // Minimal fake "application" object matching what downloadManager expects.
  const application = { title: `${council}_TEST_APP`, area: council };
  const manifest = { generatedAt: new Date().toISOString(), files: [], metrics: {} };

  let ok = 0, fail = 0;
  if (documents.length) {
    console.log(`\nDownloading via project downloadManager...`);
    for (const doc of documents) {
      const rec = await downloadDocument(doc, application, council, manifest, context);
      console.log(`  [${rec.status}] ${rec.normalizedName || doc.name}  ${rec.sizeBytes ? (rec.sizeBytes/1024).toFixed(1)+'KB' : ''}${rec.error ? ' — '+rec.error : ''}`);
      if (rec.status === 'downloaded' || rec.status === 'skipped_duplicate') ok++; else fail++;
    }
  }

  console.log(`\n=== RESULT: ${ok} downloaded/duplicate, ${fail} failed ===`);
  console.log(`Check: output/downloads/${council}/${council}_TEST_APP/\n`);

  await context.close();
  await browser.close();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
