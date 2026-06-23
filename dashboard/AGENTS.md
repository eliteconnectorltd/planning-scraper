<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:database-agent-rules -->
# Database Agent Rules

> **NOTE:** You are a database expert with read/write access to the project's PostgreSQL database.

## Database Schema

### Tables

#### `applications`
Stores all application records.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT | Primary Key (UUID) |
| `case_number` | TEXT | Unique case number (e.g., "UTT/26/1277/DOC") |
| `district` | TEXT | Administrative district |
| `sub_division` | TEXT | Sub-division within district |
| `planning_office` | TEXT | Planning authority office |
| `village` | TEXT | Village or locality |
| `block` | TEXT | Administrative block |
| `ward` | TEXT | Ward number |
| `post_office` | TEXT | Post office name |
| `house_number` | TEXT | House or building number |
| `applicant_name` | TEXT | Name of the applicant |
| `applicant_type` | TEXT | Individual, firm, etc. |
| `applicant_address` | TEXT | Full address |
| `representative_name` | TEXT | Architect or representative |
| `application_date` | TEXT | Application submission date (YYYY-MM-DD) |
| `proposal_nature` | TEXT | Nature of proposed construction |
| `proposed_category` | TEXT | Category of construction (Category A, B, C, etc.) |
| `land_area_sqm` | NUMERIC | Area of the land in square meters |
| `built_up_area_sqm` | NUMERIC | Built-up area in square meters |
| `plot_size_width` | NUMERIC | Plot width in meters |
| `plot_size_length` | NUMERIC | Plot length in meters |
| `proposed_height` | NUMERIC | Proposed building height |
| `proposed_width` | NUMERIC | Proposed building width |
| `proposed_length` | NUMERIC | Proposed building length |
| `approval_period_from` | TEXT | Approval start date (YYYY-MM-DD) |
| `approval_period_to` | TEXT | Approval end date (YYYY-MM-DD) |
| `document_type` | TEXT | Document type (DOC, PDF, etc.) |
| `file_path` | TEXT | File path to the document |
| `created_at` | TIMESTAMPTZ | Record creation timestamp |
| `updated_at` | TIMESTAMPTZ | Record update timestamp |

### Indexes

| Index Name | Columns | Unique |
|------------|---------|--------|
| `applications_pkey` | `id` | Yes |
| `applications_case_number_key` | `case_number` | Yes |

### Foreign Keys

No foreign key relationships.

### Constraints

| Constraint | Definition |
|------------|------------|
| Primary Key | `id` |
| Unique Key | `case_number` |

---

## Tool Functions

### 1. Read Data

#### `read(table: string, options?: { filters: Array<{ column: string; operator: string; value: any }>; limit?: number; offset?: number; orderBy?: Array<{ column: string; direction: string }>; })`
Retrieve records from a table with advanced filtering.

**Parameters:**

*   `table` (string): Table name (required)
*   `options` (object): Optional query parameters
    *   `filters` (Array<{ column: string; operator: string; value: any }>): Array of filter conditions
        *   `column`: Column name
        *   `operator`: Comparison operator (e.g., `=`, `!=`, `>`, `<`, `LIKE`, `ILIKE`, `IN`, `IS NULL`, `IS NOT NULL`)
        *   `value`: Value to compare against
    *   `limit` (number): Maximum number of records to return
    *   `offset` (number): Number of records to skip
    *   `orderBy` (Array<{ column: string; direction: string }>): Array of columns to sort by
        *   `direction`: `ASC` or `DESC`

**Returns:**

*   `{ success: true, data: Array<Object> }` on success
*   `{ success: false, error: string }` on failure

**Examples:**

```json
{
  "operation": "database_read",
  "table": "applications",
  "options": {
    "filters": [
      {
        "column": "district",
        "operator": "=",
        "value": "Dehradun"
      },
      {
        "column": "application_date",
        "operator": ">=",
        "value": "2024-01-01"
      }
    ],
    "limit": 10,
    "orderBy": [
      { "column": "application_date", "direction": "DESC" }
    ]
  }
}
```

**SQL Generated:**

```sql
SELECT * FROM applications
WHERE district = 'Dehradun' AND application_date >= '2024-01-01'
ORDER BY application_date DESC
LIMIT 10;
```

---

#### `search(table: string, query: string, options?: { columns?: Array<string>; limit?: number; offset?: number; orderBy?: Array<{ column: string; direction: string }>; })`
Search for records using substring matching.

**Parameters:**

*   `table` (string): Table name (required)
*   `query` (string): Search string
*   `options` (object): Optional query parameters
    *   `columns` (Array<string>): Columns to search in (defaults to all text columns)
    *   `limit` (number): Maximum number of records
    *   `offset` (number): Offset
    *   `orderBy` (Array<{ column: string; direction: string }>): Sorting options

**Returns:**

*   `{ success: true, data: Array<Object> }`
*   `{ success: false, error: string }`

**Example:**

```json
{
  "operation": "database_search",
  "table": "applications",
  "query": "Sharma",
  "options": {
    "columns": ["applicant_name", "representative_name"],
    "limit": 20
  }
}
```

**SQL Generated:**

```sql
SELECT * FROM applications
WHERE applicant_name ILIKE '%Sharma%' OR representative_name ILIKE '%Sharma%'
LIMIT 20;
```

---

#### `count(table: string, options?: { filters: Array<{ column: string; operator: string; value: any }>; })`
Count records matching specific criteria.

**Parameters:**

*   `table` (string): Table name
*   `options` (object): Optional filters

**Returns:**

*   `{ success: true, count: number }`

**Example:**

```json
{
  "operation": "database_count",
  "table": "applications",
  "options": {
    "filters": [
      {
        "column": "district",
        "operator": "=",
        "value": "Dehradun"
      }
    ]
  }
}
```

**SQL Generated:**

```sql
SELECT COUNT(*) FROM applications
WHERE district = 'Dehradun';
```

---

#### `listTables()`
List all available tables in the database.

**Returns:**

*   `{ success: true, tables: Array<string> }`

**Example:**

```json
{
  "operation": "database_list
