# Phase 10 Location Extraction

Phase 10 uses the existing `postcode_areas` Supabase table as the source of truth. It does not create a duplicate application table; extracted records are upserted into the existing `applications` table using `application_uid`.

## Source Query

The job reads:

```sql
select *
from postcode_areas
where extract = true
and source_url is not null
and source_url <> '';
```

## Command

```bash
npm run extract-locations
```

Optional limit per location:

```bash
MAX_APPLICATIONS_PER_LOCATION=5
```

Optional smoke-test limit. Leave unset in production to process every extractable location:

```bash
MAX_LOCATIONS=1
```

Optional postcode filter for targeted smoke tests:

```bash
LOCATION_POSTCODES=BD,BS
```

Optional per-navigation timeout for slow council portals:

```bash
LOCATION_EXTRACTION_TIMEOUT_MS=15000
```

Optional advanced-search date window in days:

```bash
LOCATION_SEARCH_DAYS=14
```

## Supported Extraction

- IDOX / PublicAccess portals are extracted with Playwright.
- Salesforce, custom, and unknown portals are fingerprinted and logged as unsupported until adapters are added.
- Each location is processed independently with a persistent Playwright session, retries, timeout handling, failure screenshots, and structured logs.

## Persistence

Applications are saved through the existing repository layer:

- table: `applications`
- upsert key: `application_uid`
- location-scoped UID format: `{postcode}:{application_reference}`

This avoids duplicates when different councils reuse similar reference numbers.
