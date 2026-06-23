'use strict';

const { executeWithRetry, getClientOrNull } = require('./baseRepository');

function mapPostcodeArea(row = {}) {
  return {
    id: row.id,
    postcode: row.postcode,
    region: row.region,
    source_url: row.source_url,
    extract: Boolean(row.extract),
  };
}

async function getExtractableLocations() {
  const client = getClientOrNull();
  if (!client) return [];

  return executeWithRetry(async () => client
    .from('postcode_areas')
    .select('*')
    .eq('extract', true)
    .not('source_url', 'is', null)
    .neq('source_url', '')
    .order('postcode', { ascending: true }))
    .then(rows => (rows || []).map(mapPostcodeArea));
}

module.exports = {
  getExtractableLocations,
  mapPostcodeArea,
};
