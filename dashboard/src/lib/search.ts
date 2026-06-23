import MiniSearch from 'minisearch';
import { getMasterDataset, ApplicationRecord } from './api';

interface SearchDocument {
  id: string;
  application_id: string;
  council: string;
  address: string;
  proposal: string;
  decision: string;
  applicant: string;
  platform: string;
  document_names: string;
  document_types: string;
  _raw: ApplicationRecord;
}

type SearchApplicationResult = Partial<SearchDocument> & { _raw?: ApplicationRecord };

let searchEngineInstance: MiniSearch<SearchDocument> | null = null;
let lastIndexedAt: number = 0;

/**
 * Initializes or returns the cached MiniSearch instance.
 * For a production app this might be in a separate service, but for a local MVP, 
 * keeping it in memory in the Next.js API/Server environment is sufficient.
 */
export function getSearchEngine() {
  // Simple cache invalidation: rebuild every 10 seconds if needed, 
  // or just build once per request in dev mode (Next.js clears module cache often anyway)
  const now = Date.now();
  if (!searchEngineInstance || (now - lastIndexedAt > 10000)) {
    const records = getMasterDataset();
    
    // We must map application_id to 'id' for MiniSearch
    const documents = records.map(record => ({
      id: record.application_id ?? record.title ?? '',
      application_id: record.application_id ?? record.title ?? '',
      council: record.council || '',
      address: record.address || '',
      proposal: record.proposal || '',
      decision: record.decision || 'PENDING',
      applicant: record.applicant || '',
      platform: record.platform || '',
      // Flatten document names into a searchable string
      document_names: record.documents.map(d => d.name).join(' '),
      document_types: record.documents.map(d => d.type).join(' '),
      // Full record for returning
      _raw: record
    }));

    searchEngineInstance = new MiniSearch({
      fields: ['application_id', 'council', 'address', 'proposal', 'applicant', 'document_names', 'document_types'],
      storeFields: ['application_id', 'council', 'address', 'proposal', 'decision', '_raw'],
      searchOptions: {
        boost: { proposal: 2, application_id: 3, address: 2 },
        fuzzy: 0.2, // Allows slight typos
        prefix: true // Allows partial matches (e.g. 'ext' matches 'extension')
      }
    });

    searchEngineInstance.addAll(documents);
    lastIndexedAt = now;
  }
  
  return searchEngineInstance;
}

export interface SearchFilters {
  council?: string;
  decision?: string;
  category?: string;
}

/**
 * Performs a search with optional query and filters.
 */
export function searchApplications(query: string = '', filters: SearchFilters = {}): ApplicationRecord[] {
  const engine = getSearchEngine();
  
  let results: SearchApplicationResult[];
  
  if (query.trim()) {
    results = engine.search(query) as SearchApplicationResult[];
  } else {
    // If no query, return all records (MiniSearch doesn't have a 'match_all' easily, 
    // so we just read from the raw dataset)
    const records = getMasterDataset();
    results = records.map(r => ({
      id: r.application_id,
      application_id: r.application_id,
      council: r.council || '',
      address: r.address || '',
      proposal: r.proposal || '',
      decision: r.decision || 'PENDING',
      _raw: r
    }));
  }

  // Apply manual filters
  const filtered = results.filter(result => {
    const raw = result._raw as ApplicationRecord;
    
    if (filters.council && filters.council !== 'All' && raw.council !== filters.council) {
      return false;
    }
    
    if (filters.decision && filters.decision !== 'All' && (raw.decision || 'PENDING') !== filters.decision) {
      return false;
    }
    
    if (filters.category && filters.category !== 'All') {
      const hasCategory = raw.documents.some(d => 
        d.type.toLowerCase().includes(filters.category!.toLowerCase())
      );
      if (!hasCategory) return false;
    }
    
    return true;
  });

  return filtered.map(r => r._raw as ApplicationRecord);
}

/**
 * Extracts unique values for faceted filtering.
 */
export function getFacets() {
  const records = getMasterDataset();
  
  const councils = new Set<string>();
  const decisions = new Set<string>();
  const categories = new Set<string>();
  
  records.forEach(r => {
    if (r.council) councils.add(r.council);
    decisions.add(r.decision || 'PENDING');
    r.documents.forEach(d => {
      if (d.type) categories.add(d.type);
    });
  });
  
  return {
    councils: Array.from(councils).sort(),
    decisions: Array.from(decisions).sort(),
    categories: Array.from(categories).sort()
  };
}
