'use strict';

const assert = require('assert');
const {
  buildAuraDetailRequest,
  parseAuraDetailResponse,
  normalizeSalesforceValue,
  FWUID_REGEX,
  APP_VERSION_REGEX,
  SF_CONFIG,
} = require('../src/adapters/salesforce');

console.log('=== Salesforce contact-field extraction tests ===');

const fieldMap = SF_CONFIG['publicregister.haringey.gov.uk'].detail.fieldMap;

// ── 1. parseAuraDetailResponse against a HGY/2024/0073-shaped response ──────────
// Envelope: actions[0].returnValue.returnValue.sections[].fields[]{name,value}
const response = {
  actions: [{
    state: 'SUCCESS',
    returnValue: {
      returnValue: {
        sections: [
          {
            fields: [
              { name: 'arcusbuiltenv__Applicant_Name__c', value: 'Mr Sidhartha Sinha' },
              { name: 'arcusbuiltenv__Agent_Name__c', value: 'Mr Henry Dunleavy' },
            ],
          },
          {
            fields: [
              { name: 'arcusbuiltenv__Officer_Name__c', value: 'Eunice Huang' },
              { name: 'arcusbuiltenv__Current_Decision__c', value: 'Refuse' },
              { name: 'arcusbuiltenv__Decision_Notice_Sent_Date_Manual__c', value: '2024-03-06 00:00:00' },
              { name: 'some_other_field__c', value: 'ignored' },
            ],
          },
        ],
      },
    },
  }],
};

const parsed = parseAuraDetailResponse(response, fieldMap);
console.log('parsed:', parsed);
assert.deepStrictEqual(parsed, {
  applicant_name: 'Mr Sidhartha Sinha',
  agent_name: 'Mr Henry Dunleavy',
  case_officer: 'Eunice Huang',
  decision: 'Refuse',
  target_decision_date: '2024-03-06', // time portion stripped
});
console.log('  ✓ HGY/2024/0073 field values match expected');

// ── 2. Failure envelope throws (so the caller logs + continues) ─────────────────
assert.throws(() => parseAuraDetailResponse({ actions: [{ state: 'ERROR', error: [{ message: 'boom' }] }] }, fieldMap));
assert.throws(() => parseAuraDetailResponse({ actions: [{ state: 'SUCCESS', returnValue: {} }] }, fieldMap));
console.log('  ✓ malformed/failed responses throw');

// ── 3. normalizeSalesforceValue ─────────────────────────────────────────────────
assert.strictEqual(normalizeSalesforceValue('applicant_name', '  Jane  '), 'Jane');
assert.strictEqual(normalizeSalesforceValue('applicant_name', ''), null);
assert.strictEqual(normalizeSalesforceValue('applicant_name', null), null);
assert.strictEqual(normalizeSalesforceValue('target_decision_date', '2024-03-06'), '2024-03-06');
assert.strictEqual(normalizeSalesforceValue('target_decision_date', '2024-03-06 00:00:00'), '2024-03-06');
assert.strictEqual(normalizeSalesforceValue('target_decision_date', '06/03/2024'), null); // non-ISO → null
console.log('  ✓ value normalization (trim, empty→null, date-only)');

// ── 4. buildAuraDetailRequest embeds recordId/fwuid/appVersion correctly ────────
const body = buildAuraDetailRequest({
  recordId: 'a0iTu0000002BSPIA2',
  fwuid: 'FWUID_XYZ',
  appVersion: 'APPVER_123',
  apex: SF_CONFIG['publicregister.haringey.gov.uk'].detail.apex,
  pageUriPathTemplate: SF_CONFIG['publicregister.haringey.gov.uk'].detail.pageUriPathTemplate,
});
const params = new URLSearchParams(body);
const message = JSON.parse(params.get('message'));
const ctx = JSON.parse(params.get('aura.context'));
assert.strictEqual(params.get('aura.token'), 'null');
assert.strictEqual(params.get('aura.pageURI'), '/pr/s/planning-application/a0iTu0000002BSPIA2');
assert.strictEqual(message.actions[0].params.classname, 'PublicRegisterViewService');
assert.strictEqual(message.actions[0].params.method, 'getRecordDetails');
assert.strictEqual(message.actions[0].params.params.recordId, 'a0iTu0000002BSPIA2');
assert.strictEqual(ctx.fwuid, 'FWUID_XYZ');
assert.strictEqual(ctx.loaded['APPLICATION@markup://siteforce:communityApp'], 'APPVER_123');
console.log('  ✓ request body embeds record/fwuid/appVersion');

// ── 5. Framework-id regexes extract from page HTML ──────────────────────────────
const html = `<script>window.$A={};</script><script>$A.initAsync({"mode":"PROD","fwuid":"ABC123def","app":"siteforce:communityApp","loaded":{"APPLICATION@markup://siteforce:communityApp":"VER-9.8.7"}})</script>`;
assert.strictEqual(html.match(FWUID_REGEX)[1], 'ABC123def');
assert.strictEqual(html.match(APP_VERSION_REGEX)[1], 'VER-9.8.7');
console.log('  ✓ fwuid + appVersion regexes extract from page HTML');

console.log('\nAll Salesforce contact-field unit tests passed');
