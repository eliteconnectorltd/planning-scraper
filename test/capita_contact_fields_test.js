'use strict';

// Fixture test for parseNorthgateContactFields against the ACTUAL Wandsworth
// Northgate detail-page layout: <div><span>LABEL</span>VALUE</div>.
const assert = require('assert');
const { parseNorthgateContactFields } = require('../src/adapters/capita-planning-case');

const html = `
  <ul class="list">
    <li><div><span>Applicant</span>Mr. Huu Cong Nguyen </div></li>
    <li><div><span>Agent</span>&nbsp;</div></li>
    <li><div><span>Case Officer / Tel</span>Christina Sirl
      &nbsp;</div></li>
    <li><div><span>Decision</span>Approve No Conditions
      10/05/2024</div></li>
  </ul>
`;

const result = parseNorthgateContactFields(html);
console.log(result);

const expected = {
  applicant_name: 'Mr. Huu Cong Nguyen',
  agent_name: null,
  agent_company: null,
  agent_address: null,
  case_officer: 'Christina Sirl',
  decision: 'Approve No Conditions',
  target_decision_date: null,
  consultation_start_date: null,
};

assert.deepStrictEqual(result, expected);
console.log('\n[capita contact fields] fixture test passed');
