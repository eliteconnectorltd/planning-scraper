'use strict';

const assert = require('assert');
const hardening = require('../src/browserHardening');

console.log('=== Phase 9 Browser Hardening Tests ===');
const viewport = hardening.randomViewport();
assert.ok(viewport.width >= 1280);
assert.ok(viewport.height >= 720);
assert.ok(Array.isArray(hardening.USER_AGENTS));
assert.ok(hardening.USER_AGENTS.length >= 2);
console.log('Phase 9 browser hardening tests passed');
