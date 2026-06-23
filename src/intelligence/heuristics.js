/**
 * src/intelligence/heuristics.js
 *
 * Central keyword tables, filename patterns, and type-field mappings
 * used across the classifier and metadata extractor.
 * Pure functions — no I/O, no state.
 */

// ── DOCUMENT CATEGORY DEFINITIONS ────────────────────────────────────────────

const CATEGORIES = {
  DECISION_NOTICE:          'Decision Notice',
  FLOOR_PLAN:               'Floor Plan',
  ELEVATION_DRAWING:        'Elevation Drawing',
  SITE_PLAN:                'Site Plan',
  DESIGN_ACCESS_STATEMENT:  'Design & Access Statement',
  HERITAGE_STATEMENT:       'Heritage Statement',
  TRANSPORT_ASSESSMENT:     'Transport Assessment',
  DRAINAGE_REPORT:          'Drainage Report',
  SUPPORTING_DOCUMENT:      'Supporting Document',
  UNKNOWN:                  'Unknown'
};

// ── KEYWORD TABLES ────────────────────────────────────────────────────────────
// Each entry: { keywords: string[], weight: number }
// Higher weight = more specific / reliable signal.

const CATEGORY_RULES = [
  {
    category: CATEGORIES.DECISION_NOTICE,
    keywords: [
      'decision notice', 'decision letter', 'decision cert', 'planning decision',
      'grant of planning', 'refusal notice', 'delegated decision', 'approval notice',
      'committee decision', 'appeal decision', 'approved subject to', 'permitted development'
    ],
    weight: 10
  },
  {
    category: CATEGORIES.FLOOR_PLAN,
    keywords: [
      'floor plan', 'floor plans', 'ground floor', 'first floor', 'second floor',
      'basement plan', 'loft plan', 'roof plan', 'internal layout', 'floorplan',
      'proposed floor', 'existing floor', 'plan layout'
    ],
    weight: 9
  },
  {
    category: CATEGORIES.ELEVATION_DRAWING,
    keywords: [
      'elevation', 'elevations', 'north elevation', 'south elevation', 'east elevation',
      'west elevation', 'front elevation', 'rear elevation', 'side elevation',
      'proposed elevations', 'existing elevations', 'street elevation'
    ],
    weight: 9
  },
  {
    category: CATEGORIES.SITE_PLAN,
    keywords: [
      'site plan', 'location plan', 'block plan', 'site layout', 'site layout plan',
      'existing site', 'proposed site', 'topographic', 'ordnance survey', 'os plan',
      'red line plan', 'blue line plan', 'site boundary'
    ],
    weight: 9
  },
  {
    category: CATEGORIES.DESIGN_ACCESS_STATEMENT,
    keywords: [
      'design and access statement', 'design & access', 'design statement',
      'access statement', 'design access', 'das', 'planning statement',
      'design rationale', 'design philosophy', 'architectural statement'
    ],
    weight: 10
  },
  {
    category: CATEGORIES.HERITAGE_STATEMENT,
    keywords: [
      'heritage statement', 'heritage impact', 'listed building', 'conservation area',
      'archaeological', 'historic england', 'heritage assessment', 'cultural heritage',
      'built heritage', 'scheduled monument', 'heritage significance'
    ],
    weight: 10
  },
  {
    category: CATEGORIES.TRANSPORT_ASSESSMENT,
    keywords: [
      'transport assessment', 'transport statement', 'travel plan', 'traffic impact',
      'transport appraisal', 'highways assessment', 'traffic assessment',
      'parking strategy', 'transport note', 'trip generation', 'road safety audit'
    ],
    weight: 10
  },
  {
    category: CATEGORIES.DRAINAGE_REPORT,
    keywords: [
      'drainage', 'drainage strategy', 'flood risk assessment', 'flood risk',
      'sustainable drainage', 'suds', 'surface water', 'foul drainage',
      'water management', 'drainage scheme', 'hydraulic', 'drainage assessment'
    ],
    weight: 10
  },
  {
    category: CATEGORIES.SUPPORTING_DOCUMENT,
    keywords: [
      'supporting document', 'supporting information', 'additional information',
      'technical note', 'report', 'statement', 'assessment', 'appendix',
      'letter', 'correspondence', 'schedule', 'specification', 'form'
    ],
    weight: 2  // Low weight — catch-all
  }
];

// ── FILENAME PATTERN MATCHERS ─────────────────────────────────────────────────
// Regex patterns checked against the filename (case insensitive).

const FILENAME_PATTERNS = [
  { pattern: /decision.?notice|decision.?letter|appeal.?decision/i,    category: CATEGORIES.DECISION_NOTICE,         weight: 10 },
  { pattern: /floor.?plan|ground.?floor|first.?floor|basement.?plan/i, category: CATEGORIES.FLOOR_PLAN,             weight: 9  },
  { pattern: /elevation|elev\b/i,                                       category: CATEGORIES.ELEVATION_DRAWING,      weight: 9  },
  { pattern: /site.?plan|location.?plan|block.?plan|red.?line/i,       category: CATEGORIES.SITE_PLAN,              weight: 9  },
  { pattern: /design.?access|d[_\s&]?a[_\s]?s(tatement)?/i,           category: CATEGORIES.DESIGN_ACCESS_STATEMENT, weight: 10 },
  { pattern: /heritage|listed.?building|conservation/i,                 category: CATEGORIES.HERITAGE_STATEMENT,     weight: 9  },
  { pattern: /transport|travel.?plan|traffic/i,                         category: CATEGORIES.TRANSPORT_ASSESSMENT,   weight: 9  },
  { pattern: /drain|flood.?risk|suds|surface.?water/i,                  category: CATEGORIES.DRAINAGE_REPORT,        weight: 9  }
];

// ── TYPE FIELD MAPPINGS ───────────────────────────────────────────────────────
// Maps Idox "document type" strings to our canonical categories.

const TYPE_FIELD_MAP = {
  'decision notice':              CATEGORIES.DECISION_NOTICE,
  'planning decision':            CATEGORIES.DECISION_NOTICE,
  'appeal decision':              CATEGORIES.DECISION_NOTICE,
  'floor plans':                  CATEGORIES.FLOOR_PLAN,
  'floor plan':                   CATEGORIES.FLOOR_PLAN,
  'proposed floor plans':         CATEGORIES.FLOOR_PLAN,
  'elevations':                   CATEGORIES.ELEVATION_DRAWING,
  'proposed elevations':          CATEGORIES.ELEVATION_DRAWING,
  'existing and proposed elevation': CATEGORIES.ELEVATION_DRAWING,
  'site plan':                    CATEGORIES.SITE_PLAN,
  'location plan':                CATEGORIES.SITE_PLAN,
  'block plan':                   CATEGORIES.SITE_PLAN,
  'design and access statement':  CATEGORIES.DESIGN_ACCESS_STATEMENT,
  'design & access statement':    CATEGORIES.DESIGN_ACCESS_STATEMENT,
  'planning statement':           CATEGORIES.DESIGN_ACCESS_STATEMENT,
  'heritage statement':           CATEGORIES.HERITAGE_STATEMENT,
  'listed building assessment':   CATEGORIES.HERITAGE_STATEMENT,
  'transport assessment':         CATEGORIES.TRANSPORT_ASSESSMENT,
  'transport statement':          CATEGORIES.TRANSPORT_ASSESSMENT,
  'travel plan':                  CATEGORIES.TRANSPORT_ASSESSMENT,
  'drainage strategy':            CATEGORIES.DRAINAGE_REPORT,
  'flood risk assessment':        CATEGORIES.DRAINAGE_REPORT,
  'drainage assessment':          CATEGORIES.DRAINAGE_REPORT,
  'supporting documents':         CATEGORIES.SUPPORTING_DOCUMENT,
  'additional information':       CATEGORIES.SUPPORTING_DOCUMENT,
  'correspondence':               CATEGORIES.SUPPORTING_DOCUMENT,
  'technical note':               CATEGORIES.SUPPORTING_DOCUMENT
};

// ── METADATA EXTRACTION PATTERNS ──────────────────────────────────────────────

const METADATA_PATTERNS = {
  applicationRef:  [
    /application\s+(?:reference|ref|no\.?|number)[:\s]+([A-Z0-9\/\-\.]+)/i,
    /planning\s+(?:application|reference)\s+([A-Z0-9\/\-\.]+)/i,
    /ref(?:erence)?[:\s]+([A-Z0-9\/\-\.]{5,})/i
  ],
  decision: [
    /(?:hereby|is)\s+(?:granted|approved|permitted)/i,
    /permission\s+is\s+(?:granted|given|approved)/i,
    /application\s+is\s+(?:refused|rejected)/i,
    /(?:be|is)\s+refused/i,
    /(?:hereby|is)\s+refused/i
  ],
  decisionDate: [
    /date\s+of\s+decision[:\s]+(\d{1,2}(?:st|nd|rd|th)?[\s\/\-]\w+[\s\/\-]\d{2,4})/i,
    /(?:decision|determined|dated?)[^\d]{0,30}(\d{1,2}(?:st|nd|rd|th)?(?:\s+day\s+of)?\s+\w+\s+\d{2,4})/i,
    /(\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{2,4})/i
  ],
  applicant: [
    /applicant[:\s]+([^\n\r]{3,60})/i,
    /on\s+behalf\s+of[:\s]+([^\n\r]{3,60})/i
  ],
  address: [
    /(?:site|property|premises)[:\s]+address[:\s]*([^\n\r]{5,100})/i,
    /address\s+of\s+(?:site|property)[:\s]+([^\n\r]{5,100})/i
  ],
  proposal: [
    /(?:proposed?|proposal|description of\s+(?:development|works?|proposal))[:\s]+([^\n\r]{10,200})/i,
    /(?:for\s+the\s+(?:erection|construction|installation|demolition|change))[^\n\r]{0,200}/i
  ]
};

/**
 * Normalises a string to lowercase trimmed for consistent comparison.
 */
function normalise(str) {
  return (str || '').toLowerCase().trim();
}

module.exports = {
  CATEGORIES,
  CATEGORY_RULES,
  FILENAME_PATTERNS,
  TYPE_FIELD_MAP,
  METADATA_PATTERNS,
  normalise
};
