'use strict';

const assert = require('assert');
const { CHALLENGE_PATTERNS } = require('../src/browserChallenges');
const { classifyPortal, PLATFORM_TYPES } = require('../src/platforms/fingerprint');

console.log('=== Phase 9 Challenge Detection Tests ===');
const challengeText = 'Verify you are human before continuing. Cloudflare Turnstile';
assert.ok(CHALLENGE_PATTERNS.some(pattern => pattern.test(challengeText)));
assert.equal(classifyPortal('https://example.test', challengeText), PLATFORM_TYPES.CLOUDFLARE_PROTECTED);
assert.equal(classifyPortal('https://pa.example.gov.uk/online-applications/applicationDetails.do'), PLATFORM_TYPES.IDOX);
assert.equal(classifyPortal('https://example.my.salesforce.com/s/planning-application/abc'), PLATFORM_TYPES.SALESFORCE);
console.log('Phase 9 challenge detection tests passed');
