# Planning Intelligence Platform

Phase 9 upgrades the local JSON MVP into a production-ready acquisition platform with optional Supabase persistence, BullMQ workers, hardened browser automation, and operational analytics.

## Setup

```bash
npm install
cp .env.example .env
```

Set these values for Supabase-backed runs:

```bash
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

Apply the database schema from:

```text
supabase/migrations/001_phase9_schema.sql
```

JSON files under `output/` are still written for backwards compatibility.

## Local Run

```bash
npm start
npm run intelligence
npm run platform
```

## Distributed Workers

Start Redis, then run workers independently:

```bash
npm run worker:scrape
npm run worker:download
npm run worker:intelligence
npm run worker:retry
```

Queue names:

- `scrape`
- `download`
- `intelligence`
- `retry`
- `dead-letter`

## Browser Hardening

The scraper uses hardened Playwright contexts with:

- persistent browser sessions
- rotating user agents
- viewport randomization
- language and timezone matching
- navigator and WebGL masking
- challenge detection and diagnostics

Challenge pages are classified as blocked and diagnostic assets are saved under `debug/`. The system does not attempt to bypass protected systems.

## Dashboard

```bash
cd dashboard
npm install
npm run dev
```

Dashboard API routes query Supabase when configured and fall back to local JSON:

- `/api/applications`
- `/api/search`
- `/api/changes`
- `/api/analytics`
- `/api/dataset`

## Tests

```bash
npm test
npm run test-platform
npm run test-intel
npm run test-phase9
node test/download_tests.js
node test/run_manager_tests.js
```

## Architecture

See [docs/phase9-architecture.md](docs/phase9-architecture.md).
